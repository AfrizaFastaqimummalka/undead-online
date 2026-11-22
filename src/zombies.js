// zombies.js — zombie GLB model + AI + animation
// zombie.glb: Sketchfab model, 1 anim "Take 01", skinned mesh, 23 bones
// ARSITEKTUR: GLB instances di-add langsung ke SCENE (bukan child zombie group)
// Transform posisi/rotasi di-sync manual di updateTargets


import * as THREE from 'three';
import { PI, PI2, state } from './state.js';
import { ASSETS } from './config.js';
import { playZombieGrowl, playHit as playHitSound } from './audio.js';
import { showHitmarker } from './ui.js';
import { createContactShadow, updateContactShadow, removeContactShadow } from './effects.js';
import { sendHit, sendPickup } from './net.js';

// zombies.js (multiplayer) — RENDERER zombie. AI, spawn, HP, wave & damage dijalankan SERVER (server/src/room.js).
let scene, camera;

// ── GLB state ──
let glbTemplate    = null;  // master clone di scene (invisible, untuk SkeletonUtils.clone)
let glbAnimClip    = null;  // AnimationClip "Take 01"
let glbSkeleton    = null;  // SkeletonUtils module
let glbReady       = false;

// Map: zombie group → { model, mixer, action }
const glbInstances = new Map();

// ─────────────────────────────────────────────────────
// LOAD zombie.glb
// ─────────────────────────────────────────────────────
async function loadZombieGLB() {
  try {
    const headRes = await fetch(ASSETS.zombie, { method: 'HEAD' });
    if (!headRes.ok) throw new Error('File not found: models/zombie.glb');

    const [{ GLTFLoader }, skeletonMod] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/utils/SkeletonUtils.js'),
    ]);
    // Three.js 0.170: SkeletonUtils export named function 'clone' langsung
    const cloneFn = skeletonMod.clone
                 || (skeletonMod.SkeletonUtils && skeletonMod.SkeletonUtils.clone)
                 || (skeletonMod.default && skeletonMod.default.clone);
    if (!cloneFn) throw new Error('SkeletonUtils.clone not found in module: ' + Object.keys(skeletonMod).join(', '));
    glbSkeleton = { clone: cloneFn };

    const gltf  = await new GLTFLoader().loadAsync(ASSETS.zombie);
    const model = gltf.scene;

    // Sembunyikan shadow plane Sketchfab (Plane_0)
    model.traverse(o => {
      if (o.name === 'Plane_0' || o.name === 'Plane') o.visible = false;
    });

    // Normalisasi tinggi → 1.8 unit
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const h   = box.max.y - box.min.y;
    const sc  = h > 0 ? 1.8 / h : 1;
    model.scale.setScalar(sc);
    model.updateMatrixWorld(true);

    // Injak lantai ke Y=0
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.y = -box2.min.y;
    model.updateMatrixWorld(true);

    // Fix material (hapus metalness, pertahankan texture)
    model.traverse(o => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow    = true;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => {
        if (!m) return;
        if (m.metalness !== undefined) m.metalness = 0;
        if (m.roughness !== undefined) m.roughness = 0.75;
        m.needsUpdate = true;
      });
    });

    // Simpan template di scene sebagai staging (invisible)
    model.visible = false;
    model.name    = '__zombieTemplate';
    scene.add(model);

    glbTemplate = model;
    glbAnimClip = (gltf.animations && gltf.animations.length > 0) ? gltf.animations[0] : null;
    glbReady    = true;

    console.log('[zombies] GLB ready ✓  scale=' + sc.toFixed(3) +
                '  anim=' + (glbAnimClip ? glbAnimClip.name : 'none'));

    // Upgrade zombie yang sudah spawn pakai procedural
    upgradeNetZombies();

  } catch (e) {
    console.warn('[zombies] GLB load failed → procedural fallback:', e.message);
    glbReady = false;
  }
}

// ─────────────────────────────────────────────────────
// BUAT SATU INSTANCE GLB
// Penting: model di-add ke SCENE langsung, bukan ke zombie group
// Posisi di-sync manual setiap frame
// ─────────────────────────────────────────────────────
function createGLBInstance(zombieGroup) {
  // Clone skeleton + mesh dari template
  const clone = glbSkeleton.clone(glbTemplate);
  clone.visible = true;
  clone.name    = '__zombieInstance';

  // Clone material agar flash merah tidak menular
  clone.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.frustumCulled = true;   // Three.js auto-cull zombie di luar view
    o.castShadow    = false;  // hemat GPU: matikan shadow per-zombie
    if (o.material) {
      o.material = Array.isArray(o.material)
        ? o.material.map(m => m ? m.clone() : m)
        : o.material.clone();
    }
  });

  // Tag DULU sebelum scene.add — agar raycast bisa trace ke zombieGroup
  clone.userData.zombieGroup = zombieGroup;
  clone.traverse(o => { o.userData.zombieGroup = zombieGroup; });

  // Tambah langsung ke scene (BUKAN ke zombieGroup)
  scene.add(clone);

  // Setup AnimationMixer
  const mixer  = new THREE.AnimationMixer(clone);
  let   action = null;
  if (glbAnimClip) {
    action = mixer.clipAction(glbAnimClip);
    action.loop      = THREE.LoopRepeat;
    action.timeScale = 1.0;
    action.reset().play();
  }

  // Cache material references → hemat traverse saat flash merah
  const cachedMats = [];
  const origColors = [];
  clone.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => {
      if (m && m.color) {
        cachedMats.push(m);
        origColors.push(m.color.getHex());
      }
    });
  });

  // Simpan referensi
  glbInstances.set(zombieGroup.uuid, { clone, mixer, action, cachedMats, origColors });

  return { clone, mixer, action };
}

// ─────────────────────────────────────────────────────
// HAPUS GLB INSTANCE
// ─────────────────────────────────────────────────────
function removeGLBInstance(zombieGroup) {
  const inst = glbInstances.get(zombieGroup.uuid);
  if (!inst) return;
  if (inst.mixer) { inst.mixer.stopAllAction(); inst.mixer.uncacheRoot(inst.clone); }
  scene.remove(inst.clone);
  // Tidak dispose material/geometry GLB karena di-share antar instance
  // Hanya hapus referensi
  glbInstances.delete(zombieGroup.uuid);
}

// ─────────────────────────────────────────────────────
// SYNC posisi GLB instance ke zombie group (tiap frame)
// ─────────────────────────────────────────────────────
function syncGLBInstance(zombieGroup) {
  const inst = glbInstances.get(zombieGroup.uuid);
  if (!inst) return;
  const { clone } = inst;
  clone.position.copy(zombieGroup.position);
  clone.rotation.y = zombieGroup.rotation.y + Math.PI; // offset 180° — model GLB menghadap -Z
  clone.scale.copy(zombieGroup.scale);
  clone.visible = zombieGroup.visible;
}

// ─────────────────────────────────────────────────────
// PROCEDURAL FALLBACK — box zombie
// ─────────────────────────────────────────────────────
function buildProcedural(z) {
  const skinMat = new THREE.MeshStandardMaterial({ color:0x5a7a4a, roughness:0.85 });
  const dkMat   = new THREE.MeshStandardMaterial({ color:0x3a5a3a, roughness:0.9  });
  const cthMat  = new THREE.MeshStandardMaterial({ color:0x2a3a2a, roughness:0.9  });
  const eyeMat  = new THREE.MeshBasicMaterial({ color:0xff2200 });

  function mk(geo, mat, px, py, pz, parent) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.userData.zombieGroup = z;
    (parent || z).add(m);
    return m;
  }

  mk(new THREE.BoxGeometry(0.7, 0.7, 0.4),  cthMat,  0,    1.0,   0);
  const head = mk(new THREE.BoxGeometry(0.45,0.45,0.45), skinMat, 0, 1.6, 0);
  mk(new THREE.BoxGeometry(0.08,0.06,0.04), eyeMat, -0.14, 1.65, -0.24);
  mk(new THREE.BoxGeometry(0.08,0.06,0.04), eyeMat,  0.14, 1.65, -0.24);

  const laG = new THREE.Group(); laG.position.set(-0.45,1.35,0); laG.userData.zombieGroup=z;
  mk(new THREE.BoxGeometry(0.12,0.5,0.12), dkMat, 0,-0.25,0, laG); z.add(laG);
  const raG = new THREE.Group(); raG.position.set( 0.45,1.35,0); raG.userData.zombieGroup=z;
  mk(new THREE.BoxGeometry(0.12,0.5,0.12), dkMat, 0,-0.25,0, raG); z.add(raG);
  const llG = new THREE.Group(); llG.position.set(-0.18,0.65,0); llG.userData.zombieGroup=z;
  mk(new THREE.BoxGeometry(0.15,0.55,0.15), cthMat, 0,-0.275,0, llG); z.add(llG);
  const rlG = new THREE.Group(); rlG.position.set( 0.18,0.65,0); rlG.userData.zombieGroup=z;
  mk(new THREE.BoxGeometry(0.15,0.55,0.15), cthMat, 0,-0.275,0, rlG); z.add(rlG);

  z.userData.isGLB     = false;
  z.userData.glbClone  = null;
  z.userData.mixer     = null;
  z.userData.action    = null;
  z.userData.parts     = { leftArm:laG, rightArm:raG, leftLeg:llG, rightLeg:rlG, head };
  z.userData.materials = { skinMat, darkSkinMat:dkMat, clothMat:cthMat, eyeMat };
  z.userData.zombieGroup = z;
  z.traverse(o => { if (o!==z) o.userData.zombieGroup = z; });
}

// ─────────────────────────────────────────────────────
// BOSS — tetap procedural (identitas unik)
// ─────────────────────────────────────────────────────
function buildBoss(z) {
  const bodyMat  = new THREE.MeshStandardMaterial({ color:0x8b0000, roughness:0.8 });
  const headMat  = new THREE.MeshStandardMaterial({ color:0xcc3333, roughness:0.7 });
  const armMat   = new THREE.MeshStandardMaterial({ color:0x8b0000, roughness:0.8 });
  const legMat   = new THREE.MeshStandardMaterial({ color:0x660000, roughness:0.9 });
  const crownMat = new THREE.MeshStandardMaterial({ color:0xffd700, roughness:0.3, metalness:0.8 });
  const eyeMat   = new THREE.MeshBasicMaterial({ color:0xff0000 });

  function bk(geo,mat,px,py,pz,par) {
    const m=new THREE.Mesh(geo,mat); m.position.set(px,py,pz);
    m.castShadow=true; m.userData.zombieGroup=z; (par||z).add(m); return m;
  }

  bk(new THREE.BoxGeometry(0.6,0.6,0.4), bodyMat, 0,1.0,0);
  const head=bk(new THREE.BoxGeometry(0.4,0.4,0.4), headMat, 0,1.55,0);
  bk(new THREE.BoxGeometry(0.1,0.08,0.04),eyeMat,-0.14,1.6,-0.22);
  bk(new THREE.BoxGeometry(0.1,0.08,0.04),eyeMat, 0.14,1.6,-0.22);

  const laG=new THREE.Group(); laG.position.set(-0.4,1.3,0); laG.userData.zombieGroup=z;
  bk(new THREE.BoxGeometry(0.14,0.55,0.14),armMat,0,-0.275,0,laG); z.add(laG);
  const raG=new THREE.Group(); raG.position.set(0.4,1.3,0); raG.userData.zombieGroup=z;
  bk(new THREE.BoxGeometry(0.14,0.55,0.14),armMat,0,-0.275,0,raG); z.add(raG);
  const llG=new THREE.Group(); llG.position.set(-0.18,0.6,0); llG.userData.zombieGroup=z;
  bk(new THREE.BoxGeometry(0.16,0.5,0.16),legMat,0,-0.25,0,llG); z.add(llG);
  const rlG=new THREE.Group(); rlG.position.set(0.18,0.6,0); rlG.userData.zombieGroup=z;
  bk(new THREE.BoxGeometry(0.16,0.5,0.16),legMat,0,-0.25,0,rlG); z.add(rlG);

  const cb=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.06,0.28),crownMat);
  cb.position.y=1.78; z.add(cb);
  [-1,0,1].forEach(i=>{
    const sp=new THREE.Mesh(new THREE.BoxGeometry(0.04,0.1,0.04),crownMat);
    sp.position.set(i*0.1,1.86,0); z.add(sp);
  });

  z.userData.isGLB     = false;
  z.userData.glbClone  = null;
  z.userData.mixer     = null;
  z.userData.action    = null;
  z.userData.parts     = {leftArm:laG, rightArm:raG, leftLeg:llG, rightLeg:rlG, head};
  z.userData.materials = {bodyMat,headMat,armMat,legMat,eyeMat,crownMat};
  z.userData.zombieGroup = z;
  z.traverse(o=>{ if(o!==z) o.userData.zombieGroup=z; });
}


export function initZombies(s, c) {
  scene = s; camera = c;
  loadZombieGLB();
}

// ─────────────────────────────────────────────────────
// ZOMBIE DARI SERVER
// ─────────────────────────────────────────────────────
const TYPES = ['normal', 'tank', 'boss'];
const LOCAL_DMG = { pistol: 35, rifle: 25, smg: 15, katana: 60 }; // hanya untuk prediksi bar HP lokal
const zmap = new Map();   // zid → zombie group

function disposeObj(o) {
  o.traverse(c => {
    if (c.geometry) c.geometry.dispose();
    const m = c.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach(x => x.dispose && x.dispose());
  });
}

function attachGLB(z) {
  const d = z.userData;
  const { clone, mixer, action } = createGLBInstance(z);
  const noop = new THREE.Group();
  d.isGLB = true; d.glbClone = clone; d.mixer = mixer; d.action = action;
  d.parts = { leftArm: noop, rightArm: noop, leftLeg: noop, rightLeg: noop, head: noop };
  d.materials = {};
  // Hitbox tak terlihat → target raycast peluru (clone GLB ada di scene terpisah)
  const hitbox = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.8, 0.7),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  hitbox.position.y = 0.9;
  hitbox.userData.zombieGroup = z;
  z.add(hitbox);
  d.hitbox = hitbox;
}

function upgradeNetZombies() {
  let n = 0;
  for (const z of zmap.values()) {
    const d = z.userData;
    if (d.type === 'boss' || d.isGLB) continue;
    while (z.children.length) z.remove(z.children[0]);
    attachGLB(z); n++;
  }
  if (n) console.log('[zombies] Upgraded ' + n + ' zombie → GLB');
}

function makeBar(isBoss) {
  const bg = new THREE.Group();
  bg.renderOrder = 999;
  const bgMesh = new THREE.Mesh(
    new THREE.BoxGeometry(isBoss ? 0.9 : 0.6, isBoss ? 0.08 : 0.09, isBoss ? 0.06 : 0.02),
    new THREE.MeshBasicMaterial({ color: isBoss ? 0x333333 : 0x111111, depthTest: false })
  );
  bgMesh.renderOrder = 999; bg.add(bgMesh);
  const bfg = new THREE.Mesh(
    new THREE.BoxGeometry(isBoss ? 0.88 : 0.58, 0.07, isBoss ? 0.05 : 0.02),
    new THREE.MeshBasicMaterial({ color: isBoss ? 0xff00ff : 0x00ff44, depthTest: false })
  );
  bfg.position.z = isBoss ? 0.03 : 0.01; bfg.renderOrder = 1000; bg.add(bfg);
  return { bg, bfg };
}

function addZombie(id, type, tier, x, zz, ry) {
  const z = new THREE.Group();
  z.position.set(x, 0, zz);
  z.rotation.y = ry;
  const d = z.userData;
  d.zid = id; d.alive = true; d.type = type; d.tier = tier || 1;
  d.tx = x; d.tz = zz; d.try = ry;
  d.walkTime = Math.random() * PI2; d.curSpeed = 0;
  d.atk = 0; d.wasAtk = 0; d.attackT = 0;
  d.health = 100; d.maxHealth = 100;

  if (type === 'boss') {
    const s = 2.0 + d.tier * 0.5; z.scale.set(s, s, s);
    buildBoss(z);
  } else {
    if (type === 'tank') z.scale.set(1.8, 1.8, 1.8);
    if (glbReady) attachGLB(z); else buildProcedural(z);
  }

  const { bg, bfg } = makeBar(type === 'boss');
  d.barGroup = bg; d.barFg = bfg;
  scene.add(bg); scene.add(z);
  state.targets.push(z);
  createContactShadow(z);
  zmap.set(id, z);
  return z;
}

function removeZombie(z) {
  const d = z.userData;
  z.visible = false; d.alive = false;
  removeGLBInstance(z);
  if (d.barGroup) { scene.remove(d.barGroup); disposeObj(d.barGroup); }
  scene.remove(z);
  const idx = state.targets.indexOf(z); if (idx !== -1) state.targets.splice(idx, 1);
  zmap.delete(d.zid);
  removeContactShadow(z);
  disposeObj(z);
}

/** Dipanggil tiap snapshot server: [id,x,z,ry,hp,maxHp,typeCode,atk,tier] */
export function netApplyZombies(list) {
  const seen = new Set();
  for (const a of list) {
    const id = a[0]; seen.add(id);
    let z = zmap.get(id);
    if (!z) z = addZombie(id, TYPES[a[6]] || 'normal', a[8], a[1], a[2], a[3]);
    const d = z.userData;
    d.tx = a[1]; d.tz = a[2]; d.try = a[3];
    d.health = a[4]; d.maxHealth = a[5]; d.atk = a[7];
  }
  for (const [id, z] of zmap) if (!seen.has(id)) removeZombie(z);
}

export function netZombieDie(ev) {
  const z = zmap.get(ev.id); if (!z) return;
  const pos = z.position.clone();
  const boss = z.userData.type === 'boss', tier = z.userData.tier || 1;
  removeZombie(z);
  if (boss) {
    createBigExplosion(pos, tier);
    state.shakeIntensity = Math.max(state.shakeIntensity, 0.3 + tier * 0.05);
  } else createExplosion(pos);
}

export function clearAllZombies() {
  for (const z of [...zmap.values()]) removeZombie(z);
  state.targets.length = 0;
}

// ─────────────────────────────────────────────────────
// UPDATE (interpolasi + animasi)
// ─────────────────────────────────────────────────────
const _barLook = new THREE.Vector3();
let _lastGrowl = 0;
export function updateTargets(dt) {
  const now = performance.now();
  const pp = camera.position;
  const kPos = 1 - Math.exp(-dt * 14);
  const kRot = Math.min(1, dt * 8);

  for (let i = state.targets.length - 1; i >= 0; i--) {
    const t = state.targets[i], data = t.userData;
    const isBoss = data.type === 'boss';

    // posisi: interpolasi ke target server
    const ox = t.position.x, oz = t.position.z;
    const ex = data.tx - ox, ez = data.tz - oz;
    if (ex * ex + ez * ez > 25) { t.position.x = data.tx; t.position.z = data.tz; }   // teleport (respawn)
    else { t.position.x += ex * kPos; t.position.z += ez * kPos; }
    // rotasi: jalur terpendek
    let diff = data.try - t.rotation.y;
    while (diff > PI) diff -= PI2; while (diff < -PI) diff += PI2;
    t.rotation.y += diff * kRot;

    const moved = Math.hypot(t.position.x - ox, t.position.z - oz) / Math.max(dt, 1e-4);
    data.curSpeed += (moved - data.curSpeed) * Math.min(1, dt * 6);

    const dx = pp.x - t.position.x, dz = pp.z - t.position.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);
    if (distXZ < 20 && now - _lastGrowl > 350) { _lastGrowl = now; playZombieGrowl(); }

    const attackDur = isBoss ? 1.0 : 0.6;
    if (data.atk) {
      if (!data.wasAtk) data.attackT = 0;
      data.attackT += dt;
      const ph = Math.min(data.attackT / attackDur, 1);
      if (isBoss) {
        if (ph < 0.35) {
          const p = ph / 0.35;
          data.parts.leftArm.rotation.x = -p * 1.3; data.parts.rightArm.rotation.x = -p * 1.3;
          t.rotation.x = p * 0.3;
        } else if (ph < 0.65) {
          const p = (ph - 0.35) / 0.3;
          data.parts.leftArm.rotation.x = (1 - p) * -1.3; data.parts.rightArm.rotation.x = (1 - p) * -1.3;
          t.rotation.x = (1 - p) * 0.3;
        } else {
          data.parts.leftArm.rotation.x *= 0.95; data.parts.rightArm.rotation.x *= 0.95; t.rotation.x *= 0.95;
        }
      } else {
        if (ph < 0.35) {
          const p = ph / 0.35; t.rotation.x = p * 0.4;
          if (!data.isGLB) { data.parts.leftArm.rotation.x = -p * 0.6; data.parts.rightArm.rotation.x = -p * 0.6; }
        } else if (ph < 0.6) {
          const p = (ph - 0.35) / 0.25; t.rotation.x = (1 - p) * 0.4; t.position.y = p * 0.3;
          if (!data.isGLB) { data.parts.leftArm.rotation.x = p * 1.0; data.parts.rightArm.rotation.x = p * 1.0; }
        } else {
          const p = (ph - 0.6) / 0.4; t.rotation.x = (1 - p) * -0.1; t.position.y = (1 - p) * 0.3;
          if (!data.isGLB) { data.parts.leftArm.rotation.x = (1 - p) * 1.0; data.parts.rightArm.rotation.x = (1 - p) * 1.0; }
        }
      }
      if (data.isGLB && data.action) data.action.timeScale = 1.8;
    } else {
      t.rotation.x *= 0.9;
      if (data.curSpeed > 0.25) {
        const spd = data.curSpeed;
        data.walkTime += spd * dt * (isBoss ? 2 : 3);
        t.position.y = Math.abs(Math.sin(data.walkTime * 2)) * (isBoss ? 0.08 : 0.05);
        if (!data.isGLB) {
          if (isBoss) {
            const sw = Math.sin(data.walkTime) * 0.3;
            data.parts.leftLeg.rotation.x = -sw; data.parts.rightLeg.rotation.x = sw;
            data.parts.leftArm.rotation.x = -0.2 + Math.sin(data.walkTime + PI) * 0.15;
            data.parts.rightArm.rotation.x = -0.2 - Math.sin(data.walkTime + PI) * 0.15;
          } else {
            const sw = Math.sin(data.walkTime) * 0.5, asw = Math.sin(data.walkTime + PI) * 0.4;
            data.parts.leftLeg.rotation.x = -sw; data.parts.rightLeg.rotation.x = sw;
            data.parts.leftArm.rotation.x = asw + (distXZ < 5 ? -0.3 : 0);
            data.parts.rightArm.rotation.x = -asw + (distXZ < 5 ? -0.3 : 0);
          }
        }
        if (data.isGLB && data.action) data.action.timeScale = 0.6 + Math.min(spd / 2.5, 1.4) * 0.8;
      } else {
        t.position.y *= 0.9;
        if (!data.isGLB) {
          data.parts.leftArm.rotation.x *= 0.9; data.parts.rightArm.rotation.x *= 0.9;
        }
      }
    }
    data.wasAtk = data.atk;

    if (data.isGLB && data.mixer) data.mixer.update(dt);
    if (data.isGLB) syncGLBInstance(t);
    updateContactShadow(t);

    // Health bar billboard
    const bg = data.barGroup;
    if (bg) {
      const pct = Math.max(0, data.health / data.maxHealth);
      data.barFg.scale.x = pct;
      data.barFg.position.x = -(1 - pct) * 0.24;
      data.barFg.material.color.setHex(isBoss ? 0xff00ff : pct > 0.6 ? 0x00ff00 : pct > 0.3 ? 0xffff00 : 0xff0000);
      bg.position.copy(t.position);
      const barHeight = isBoss ? 2.5 * (t.scale.x || 1) : data.isGLB ? 2.2 * (t.scale.y || 1) : 2.0;
      bg.position.y += barHeight;
      _barLook.set(pp.x, bg.position.y, pp.z);
      bg.lookAt(_barLook);
    }
  }
}

// ─────────────────────────────────────────────────────
// HIT — feedback lokal + kirim ke server (server yang menghitung damage)
// ─────────────────────────────────────────────────────
export function hitTarget(mesh, point, dir) {
  let o = mesh, z = null;
  while (o) { if (o.userData && o.userData.zombieGroup) { z = o.userData.zombieGroup; break; } o = o.parent; }
  if (!z || !z.userData || z.userData.zid == null) return;
  const data = z.userData;
  sendHit(data.zid, state.currentWeapon);

  // prediksi bar HP agar terasa instan (server akan mengoreksi di snapshot berikutnya)
  data.health = Math.max(1, data.health - (LOCAL_DMG[state.currentWeapon] || 20));

  const inst = glbInstances.get(z.uuid);
  if (data.isGLB && inst && inst.cachedMats) {
    inst.cachedMats.forEach(m => { if (m.color) m.color.setHex(0xff2222); });
    setTimeout(() => { if (inst.cachedMats) inst.cachedMats.forEach((m, i) => { if (m.color) m.color.setHex(inst.origColors[i]); }); }, 80);
  } else if (data.parts && data.parts.head && !data.isGLB) {
    const hd = data.parts.head;
    if (hd.material) {
      const h = hd.material.color.getHex();
      hd.material.color.setHex(0xff2222);
      setTimeout(() => { if (hd.material) hd.material.color.setHex(h); }, 70);
    }
  }
  playHitSound(); showHitmarker();
}

// ─────────────────────────────────────────────────────
// DROPS (dibuat & dihapus oleh server)
// ─────────────────────────────────────────────────────
export function netSpawnDrop(ev) {
  const isH = ev.t === 'health';
  const g = new THREE.Group(); g.position.set(ev.x, 0, ev.z);
  if (isH) {
    const rm = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0x660000, emissiveIntensity: 0.3 });
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.08), rm); v.position.y = 0.15; g.add(v);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.08), rm); h.position.y = 0.15; g.add(h);
    g.userData.type = 'health'; g.userData.value = 30;
  } else {
    const bm = new THREE.MeshStandardMaterial({ color: 0xcc8844, roughness: 0.7 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.15), bm); b.position.y = 0.075; b.castShadow = true; g.add(b);
    g.userData.type = 'ammo'; g.userData.value = 15;
  }
  g.userData.did = ev.id;
  g.userData.spawnTime = performance.now(); g.userData.floatOffset = Math.random() * PI2;
  g.userData.pendingUntil = 0;
  scene.add(g); state.drops.push(g);
}

function removeDropAt(i) {
  const d = state.drops[i];
  scene.remove(d);
  d.children.forEach(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  state.drops.splice(i, 1);
}
export function netRemoveDrop(id) {
  const i = state.drops.findIndex(d => d.userData.did === id);
  if (i !== -1) removeDropAt(i);
}
export function clearDrops() { while (state.drops.length) removeDropAt(state.drops.length - 1); }

export function updateDrops(dt) {
  const pp = camera.position;
  const now = performance.now();
  for (let i = state.drops.length - 1; i >= 0; i--) {
    const d = state.drops[i];
    const age = (now - d.userData.spawnTime) / 1000;
    if (age > 24) { removeDropAt(i); continue; }              // cadangan jika event hapus terlewat
    d.position.y = Math.sin(age * 2 + d.userData.floatOffset) * 0.1 + 0.2;
    d.rotation.y += dt * 1.5;
    if (age > 17) {
      const f = Math.max(0, 1 - (age - 17) / 3);
      d.children.forEach(c => { if (c.material) { c.material.transparent = true; c.material.opacity = f; } });
    }
    if (state.player.isDead || now < d.userData.pendingUntil) continue;
    const dx = pp.x - d.position.x, dz = pp.z - d.position.z;
    if (dx * dx + dz * dz < 1.44) {           // < 1.2 unit → minta server (server yang memvalidasi & memberi efek)
      d.userData.pendingUntil = now + 1000;
      sendPickup(d.userData.did);
    }
  }
}


// ─────────────────────────────────────────────────────
// PARTICLES
// ─────────────────────────────────────────────────────
const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const isLowEnd  = isMobile && (navigator.hardwareConcurrency||4) <= 4;
const MAX_PARTICLES = isLowEnd ? 20 : isMobile ? 40 : 80;

function mkParticle(pos, size, color, velScale, life) {
  if (state.particles.length >= MAX_PARTICLES) return; // throttle partikel
  const m=new THREE.Mesh(
    new THREE.BoxGeometry(size,size,size),
    new THREE.MeshBasicMaterial({color, transparent:true, opacity:1})
  );
  m.position.copy(pos);
  m.position.x+=(Math.random()-0.5)*0.5; m.position.z+=(Math.random()-0.5)*0.5;
  m.userData.vel=new THREE.Vector3(
    (Math.random()-0.5)*velScale, Math.random()*velScale*0.7, (Math.random()-0.5)*velScale
  );
  m.userData.life=life+Math.random()*0.4;
  scene.add(m); state.particles.push(m);
}

function createExplosion(pos) {
  const n = isLowEnd ? 2 : isMobile ? 3 : 5;
  [0x44aa00,0x66cc00,0x88ff00,0x226600].forEach(c=>{
    for(let j=0;j<n;j++) mkParticle(pos, 0.1+Math.random()*0.28, c, 8, 0.6);
  });
}

function createBigExplosion(pos, tier) {
  const n = isLowEnd ? 4 : isMobile ? 6 : 10+tier*2;
  [0xff4400,0xff8800,0xffcc00,0xff0000,0xcc00ff].forEach(c=>{
    for(let j=0;j<n;j++) mkParticle(pos, 0.15+Math.random()*0.5, c, 12, 0.8);
  });
}

export function updateParticles(dt) {
  for (let i=state.particles.length-1;i>=0;i--) {
    const p=state.particles[i];
    p.userData.life-=dt;
    if (p.userData.life<=0) {
      scene.remove(p);
      p.geometry.dispose();
      p.material.dispose();
      state.particles.splice(i,1); continue;
    }
    if (p.userData.vel) { p.userData.vel.y-=9.8*dt; p.position.addScaledVector(p.userData.vel,dt); }
    if (p.material.transparent) p.material.opacity=p.userData.life;
    p.scale.setScalar(Math.max(0.01, p.userData.life));
  }
}

