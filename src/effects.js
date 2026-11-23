// effects.js — Efek visual: hujan ringan, partikel, impact, contact shadows

import * as THREE from 'three';

const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
const isLowEnd  = isMobile && (navigator.hardwareConcurrency||4) <= 4;
import { state } from './state.js';
import { setRainVolume } from './audio.js';

let scene;

// ─── RAIN SYSTEM ─── (dikecilkan: 2500 partikel, lebih halus)
const RAIN_COUNT = isLowEnd ? 200 : isMobile ? 500 : 1500;
let rainPoints, rainPositions, rainVelocities;
const rainSplashes = [];

const contactShadows = new Map();
const MAX_DECALS = 25;
const smokeParticles = [];
export const effectParticles = [];

// ─── SHARED GEOMETRIES & MATERIALS (Menghindari GC freeze & buffer realloc di render loop) ───
const _sharedBoxGeo       = new THREE.BoxGeometry(1, 1, 1);
const _sharedFlashGeo     = new THREE.SphereGeometry(1, 4, 4);
const _sharedSmokeGeo     = new THREE.SphereGeometry(1, 4, 4);
const _sharedDecalGeo     = new THREE.CircleGeometry(0.065, 6);
const _sharedSplashGeo    = new THREE.RingGeometry(0.0, 0.04, 6);

const _sharedSparkMat     = new THREE.MeshBasicMaterial({ color: 0xffd066 });
const _sharedBloodMat     = new THREE.MeshBasicMaterial({ color: 0x990000 });
const _sharedBloodFineMat = new THREE.MeshBasicMaterial({ color: 0xaa1111 });
const _sharedFlashMat     = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
const _sharedSmokeMat     = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.18, depthWrite: false });
const _sharedDecalMat     = new THREE.MeshBasicMaterial({
  color: 0x111111, transparent: true, opacity: 0.75, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1,
});
const _sharedSplashMat    = new THREE.MeshBasicMaterial({
  color: 0xaaccff, side: THREE.DoubleSide,
  transparent: true, opacity: 0.5, depthWrite: false,
});

const MAX_EFFECT_PARTICLES = isLowEnd ? 16 : isMobile ? 28 : 60;

export function initEffects(s) {
  scene = s;
  createRainSystem();
}

function createRainSystem() {
  const geo = new THREE.BufferGeometry();
  rainPositions  = new Float32Array(RAIN_COUNT * 3);
  rainVelocities = new Float32Array(RAIN_COUNT);

  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPositions[i*3]   = (Math.random()-0.5)*60;
    rainPositions[i*3+1] = Math.random()*40;
    rainPositions[i*3+2] = (Math.random()-0.5)*60;
    rainVelocities[i]    = 14 + Math.random()*8; // lebih lambat = lebih halus
  }

  geo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));

  const mat = new THREE.PointsMaterial({
    color: 0xccddff,
    size: 0.045,          // lebih kecil
    transparent: true,
    opacity: 0.35,        // lebih transparan
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  rainPoints = new THREE.Points(geo, mat);
  rainPoints.visible = false;
  rainPoints.frustumCulled = false;
  scene.add(rainPoints);
}

export function updateRain(dt, cameraPos) {
  const r = state.rain;
  const targetIntensity = r.active ? 1 : 0;
  r.current += (targetIntensity - r.current) * dt * 1.2;

  if (r.current < 0.01) {
    rainPoints.visible = false;
    setRainVolume(0);
    updateSplashes(dt);
    return;
  }

  rainPoints.visible = true;
  rainPoints.material.opacity = 0.18 + r.current * 0.22; // max opacity 0.4
  setRainVolume(r.current * 0.55); // suara lebih pelan

  const posAttr = rainPoints.geometry.attributes.position;

  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPositions[i*3+1] -= rainVelocities[i] * dt * r.current;

    if (rainPositions[i*3+1] < 0) {
      rainPositions[i*3]   = cameraPos.x + (Math.random()-0.5)*60;
      rainPositions[i*3+1] = 38 + Math.random()*8;
      rainPositions[i*3+2] = cameraPos.z + (Math.random()-0.5)*60;

      // Splash lebih jarang (4%) dan hanya saat hujan penuh
      if (r.current > 0.6 && Math.random() < 0.04) {
        spawnPuddleSplash(new THREE.Vector3(
          rainPositions[i*3], 0.01, rainPositions[i*3+2]
        ));
      }
    }

    const dx = rainPositions[i*3]   - cameraPos.x;
    const dz = rainPositions[i*3+2] - cameraPos.z;
    if (Math.abs(dx) > 30) rainPositions[i*3]   = cameraPos.x + (Math.random()-0.5)*60;
    if (Math.abs(dz) > 30) rainPositions[i*3+2] = cameraPos.z + (Math.random()-0.5)*60;
  }

  posAttr.needsUpdate = true;
  updateSplashes(dt);
}

export function spawnPuddleSplash(pos) {
  if (rainSplashes.length > (isMobile ? 8 : 16)) return;
  const ring = new THREE.Mesh(_sharedSplashGeo, _sharedSplashMat);
  ring.rotation.x = -Math.PI/2;
  ring.position.copy(pos);
  ring.userData.life = 0; ring.userData.maxLife = 0.35;
  scene.add(ring);
  rainSplashes.push(ring);
}

function updateSplashes(dt) {
  for (let i = rainSplashes.length-1; i >= 0; i--) {
    const s = rainSplashes[i];
    s.userData.life += dt;
    const t = s.userData.life / s.userData.maxLife;
    s.scale.setScalar(1 + t*2.5);
    if (t >= 1) {
      scene.remove(s);
      rainSplashes.splice(i, 1);
    }
  }
}

export function toggleRain() { state.rain.active = !state.rain.active; }
export function setRainActive(v) { state.rain.active = v; }

// ─── CONTACT SHADOWS ───
export function createContactShadow(entity) {
  const geo = new THREE.CircleGeometry(0.55, 10);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
  });
  const shadow = new THREE.Mesh(geo, mat);
  shadow.rotation.x = -Math.PI/2;
  shadow.position.y = 0.02;
  scene.add(shadow);
  contactShadows.set(entity.uuid, shadow);
  return shadow;
}

export function updateContactShadow(entity) {
  const shadow = contactShadows.get(entity.uuid);
  if (!shadow) return;
  shadow.position.x = entity.position.x;
  shadow.position.z = entity.position.z;
  shadow.material.opacity = Math.max(0, 0.3 - Math.max(0, entity.position.y)*0.1);
}

export function removeContactShadow(entity) {
  const shadow = contactShadows.get(entity.uuid);
  if (shadow) {
    scene.remove(shadow); shadow.geometry.dispose(); shadow.material.dispose();
    contactShadows.delete(entity.uuid);
  }
}

// ─── BULLET IMPACTS ───
export function createWallImpact(pos, normal) {
  if (effectParticles.length >= MAX_EFFECT_PARTICLES) return;
  const count = isLowEnd ? 2 : isMobile ? 3 : 5;
  for (let i = 0; i < count; i++) {
    const size = 0.025 + Math.random()*0.045;
    const mesh = new THREE.Mesh(_sharedBoxGeo, _sharedSparkMat);
    mesh.scale.set(size, size, size);
    mesh.position.copy(pos);
    mesh.userData.vel = new THREE.Vector3(
      normal.x*0.4+(Math.random()-0.5)*2.5,
      0.8+Math.random()*2.5,
      normal.z*0.4+(Math.random()-0.5)*2.5,
    );
    mesh.userData.life = 0.3 + Math.random()*0.2;
    mesh.userData.maxLife = mesh.userData.life;
    mesh.userData.baseScale = size;
    scene.add(mesh); effectParticles.push(mesh);
  }
  // Flash
  const flash = new THREE.Mesh(_sharedFlashGeo, _sharedFlashMat);
  flash.scale.setScalar(0.05);
  flash.position.copy(pos);
  flash.userData.life = 0.05; flash.userData.maxLife = 0.05; flash.userData.isFlash = true;
  flash.userData.baseScale = 0.05;
  scene.add(flash); effectParticles.push(flash);
  spawnBulletDecal(pos, normal);
}

// ── Slash blood: muncrat mengikuti arah sapuan blade ──
export function createSlashBlood(pos, fwd, slashDir) {
  if (effectParticles.length >= MAX_EFFECT_PARTICLES) return;
  const sideVec = new THREE.Vector3(fwd.z * slashDir, 0, -fwd.x * slashDir).normalize();
  const splashDir = fwd.clone().multiplyScalar(0.6).addScaledVector(sideVec, 0.8).normalize();

  const count = isLowEnd ? 4 : isMobile ? 6 : 8;
  for (let i = 0; i < count; i++) {
    const size = 0.04 + Math.random() * 0.06;
    const mesh = new THREE.Mesh(_sharedBoxGeo, _sharedBloodMat);
    mesh.scale.set(size, size * 0.4, size);
    mesh.position.copy(pos).add(new THREE.Vector3(
      (Math.random()-0.5)*0.15, (Math.random()-0.5)*0.1, (Math.random()-0.5)*0.15
    ));
    const speed = 3 + Math.random() * 5;
    mesh.userData.vel = new THREE.Vector3(
      splashDir.x * speed + (Math.random()-0.5)*2,
      1.5 + Math.random() * 4,
      splashDir.z * speed + (Math.random()-0.5)*2,
    );
    mesh.userData.life = 0.4 + Math.random() * 0.3;
    mesh.userData.maxLife = mesh.userData.life;
    mesh.userData.baseScale = size;
    scene.add(mesh); effectParticles.push(mesh);
  }

  // Droplet kecil (spray halus)
  const fineCount = isLowEnd ? 2 : isMobile ? 3 : 5;
  for (let i = 0; i < fineCount; i++) {
    const size = 0.015 + Math.random() * 0.02;
    const mesh = new THREE.Mesh(_sharedBoxGeo, _sharedBloodFineMat);
    mesh.scale.set(size, size, size);
    mesh.position.copy(pos);
    mesh.userData.vel = new THREE.Vector3(
      splashDir.x * (5+Math.random()*5) + (Math.random()-0.5)*2,
      2 + Math.random() * 4,
      splashDir.z * (5+Math.random()*5) + (Math.random()-0.5)*2,
    );
    mesh.userData.life = 0.25 + Math.random() * 0.25;
    mesh.userData.maxLife = mesh.userData.life;
    mesh.userData.baseScale = size;
    scene.add(mesh); effectParticles.push(mesh);
  }
}

export function createBloodImpact(pos, dir) {
  if (effectParticles.length >= MAX_EFFECT_PARTICLES) return;
  const count = isLowEnd ? 3 : isMobile ? 4 : 6;
  for (let i = 0; i < count; i++) {
    const size = 0.03+Math.random()*0.055;
    const mesh = new THREE.Mesh(_sharedBoxGeo, _sharedBloodMat);
    mesh.scale.set(size, size, size);
    mesh.position.copy(pos).add(new THREE.Vector3((Math.random()-0.5)*0.12,0,(Math.random()-0.5)*0.12));
    mesh.userData.vel = new THREE.Vector3(
      dir.x*1.2+(Math.random()-0.5)*3,
      1.5+Math.random()*3,
      dir.z*1.2+(Math.random()-0.5)*3,
    );
    mesh.userData.life = 0.35+Math.random()*0.25;
    mesh.userData.maxLife = mesh.userData.life;
    mesh.userData.baseScale = size;
    scene.add(mesh); effectParticles.push(mesh);
  }
}

const decalList = [];
function spawnBulletDecal(pos, normal) {
  if (decalList.length > (isMobile ? 12 : 25)) {
    const old = decalList.shift();
    scene.remove(old);
  }
  const decal = new THREE.Mesh(_sharedDecalGeo, _sharedDecalMat);
  decal.position.copy(pos).addScaledVector(normal, 0.01);
  const up = new THREE.Vector3(0,1,0);
  if (Math.abs(normal.dot(up)) > 0.9) decal.rotation.x = -Math.PI/2;
  else decal.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), normal);
  decal.userData.life = 12;
  scene.add(decal); decalList.push(decal);
}

export function spawnMuzzleSmoke(pos, dir) {
  if (smokeParticles.length > (isMobile ? 4 : 8)) return;
  const mesh = new THREE.Mesh(_sharedSmokeGeo, _sharedSmokeMat);
  mesh.scale.setScalar(0.04);
  mesh.position.copy(pos).addScaledVector(dir, 0.04);
  mesh.userData.vel = new THREE.Vector3(
    (Math.random()-0.5)*0.2, 0.25+Math.random()*0.3, (Math.random()-0.5)*0.2
  );
  mesh.userData.life = 0.4+Math.random()*0.2;
  mesh.userData.maxLife = mesh.userData.life;
  mesh.userData.isSmoke = true;
  scene.add(mesh); smokeParticles.push(mesh);
}

export function updateEffectParticles(dt) {
  const GRAVITY = -9.8;
  for (let i = effectParticles.length-1; i >= 0; i--) {
    const p = effectParticles[i];
    p.userData.life -= dt;
    if (p.userData.life <= 0) {
      scene.remove(p);
      effectParticles.splice(i, 1); continue;
    }
    const t = p.userData.life / p.userData.maxLife;
    if (p.userData.isFlash) {
      const s = p.userData.baseScale * (1 - t);
      p.scale.set(s, s, s);
    } else {
      const vel = p.userData.vel;
      if (vel) {
        vel.y += GRAVITY*dt;
        p.position.addScaledVector(vel, dt);
        if (p.position.y < 0.01) {
          p.position.y = 0.01;
          vel.y = -vel.y * 0.25; vel.x *= 0.7; vel.z *= 0.7;
        }
      }
      const s = p.userData.baseScale * Math.max(0.01, t);
      p.scale.set(s, s, s);
    }
  }
  for (let i = smokeParticles.length-1; i >= 0; i--) {
    const p = smokeParticles[i];
    p.userData.life -= dt;
    if (p.userData.life <= 0) {
      scene.remove(p);
      smokeParticles.splice(i, 1); continue;
    }
    const t = p.userData.life / p.userData.maxLife;
    p.position.addScaledVector(p.userData.vel, dt);
    p.scale.setScalar(0.04 * (1 + (1-t)*2.5));
  }
  for (let i = decalList.length-1; i >= 0; i--) {
    const d = decalList[i];
    d.userData.life -= dt;
    if (d.userData.life <= 0) {
      scene.remove(d);
      decalList.splice(i, 1);
    }
  }
}


