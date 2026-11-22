// remote.js — avatar pemain lain (lobby: versi ringan, room: karakter lengkap) + name tag + animasi
import * as THREE from 'three';
import { buildAvatar } from './player.js';

// ───────── Name tag ─────────
export function makeLabelSprite(text, { color = '#ffffff', sub = '', w = 256, h = 64, scaleX = 1.9 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scaleX, scaleX * h / w, 1);
  sprite.renderOrder = 998;
  sprite.userData.canvas = canvas; sprite.userData.tex = tex;
  drawLabel(sprite, text, color, sub);
  return sprite;
}
export function drawLabel(sprite, text, color = '#fff', sub = '') {
  const c = sprite.userData.canvas, ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.95)'; ctx.shadowBlur = 8;
  const main = sub ? c.height * 0.55 : c.height * 0.62;
  ctx.font = `700 ${Math.round(main)}px Rajdhani, Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText(text, c.width / 2, sub ? c.height * 0.36 : c.height / 2);
  if (sub) {
    ctx.font = `600 ${Math.round(c.height * 0.34)}px Rajdhani, Arial, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(sub, c.width / 2, c.height * 0.78);
  }
  sprite.userData.tex.needsUpdate = true;
}
export function disposeSprite(sp) {
  sp.userData.tex?.dispose(); sp.material.dispose();
}

// ───────── Avatar ringan (lobby) ─────────
function buildLiteAvatar() {
  const body = new THREE.Group(), parts = {};
  // emissive supaya tetap terlihat jelas di lobby yang pencahayaannya redup
  const lam = c => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.55 });
  const mUni = lam(0x4a6a34), mSkin = lam(0xd8a57c), mVest = lam(0x6a7f3a), mHelm = lam(0x3d4a28), mBoot = lam(0x2a2015);
  const box = (w, h, d, m, x, y, z, par) => {
    const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    me.position.set(x, y, z); me.userData.isPlayerBody = true; (par || body).add(me); return me;
  };
  box(0.46, 0.62, 0.26, mVest, 0, 1.05, 0);
  box(0.28, 0.26, 0.26, mSkin, 0, 1.52, 0);
  box(0.32, 0.12, 0.32, mHelm, 0, 1.69, 0);
  box(0.46, 0.12, 0.24, mUni, 0, 0.72, 0);
  const arm = (sx) => {
    const g = new THREE.Group(); g.position.set(sx * 0.34, 1.32, 0);
    box(0.12, 0.34, 0.12, mUni, 0, -0.17, 0, g);
    box(0.10, 0.30, 0.10, mUni, 0, -0.47, 0, g);
    box(0.09, 0.09, 0.06, mSkin, 0, -0.64, 0, g);
    body.add(g); return g;
  };
  const leg = (sx) => {
    const g = new THREE.Group(); g.position.set(sx * 0.13, 0.70, 0);
    box(0.16, 0.38, 0.17, mUni, 0, -0.19, 0, g);
    box(0.15, 0.34, 0.16, mUni, 0, -0.55, 0, g);
    box(0.17, 0.10, 0.24, mBoot, 0, -0.69, -0.02, g);
    body.add(g); return g;
  };
  parts.rightArm = arm(+1); parts.leftArm = arm(-1);
  parts.leftLeg = leg(-1); parts.rightLeg = leg(+1);
  parts.rightArm.rotation.set(-0.6, 0, -0.12); parts.leftArm.rotation.set(-0.55, 0, 0.1);
  return { body, parts };
}

// Pose lengan per senjata (disalin dari updatePlayer di player.js)
const POSE = {
  katana: { w: [-0.55, -0.15], s: [-0.15, 0.05] },
  pistol: { w: [-0.65, -0.08], s: [-0.30, 0.08] },
  rifle:  { w: [-0.60, -0.12], s: [-0.55, 0.10] },
  smg:    { w: [-0.60, -0.12], s: [-0.55, 0.10] },
};
const lerp = THREE.MathUtils.lerp;

export class RemotePlayer {
  /** @param {{id, name, lite:boolean, color?:string}} o */
  constructor(scene, o) {
    this.scene = scene; this.id = o.id; this.name = o.name; this.lite = !!o.lite;
    const a = this.lite ? buildLiteAvatar() : buildAvatar();
    this.body = a.body; this.parts = a.parts;
    this.body.visible = true;
    if (!this.lite) this.body.traverse(c => { if (c.isMesh) c.userData.isPlayerBody = true; });
    this.tag = makeLabelSprite(o.name, { color: o.color || '#ffffff' });
    this.tag.position.set(0, 2.15, 0);
    this.body.add(this.tag);
    scene.add(this.body);

    this.tx = 0; this.ty = 1.7; this.tz = 0; this.tyaw = 0;
    this.px = 0; this.py = 1.7; this.pz = 0; this.yaw = 0;
    this.weapon = 'rifle'; this.alive = true; this.hasPos = false;
    this.walk = 0; this.speed = 0; this.hidden = false;
  }

  setTarget(x, y, z, yaw, weapon) {
    this.tx = x; this.ty = y; this.tz = z; this.tyaw = yaw;
    if (weapon) this.weapon = weapon;
    if (!this.hasPos) { this.px = x; this.py = y; this.pz = z; this.yaw = yaw; this.hasPos = true; }
  }

  setAlive(a) { this.alive = a; }
  setHidden(h) { this.hidden = h; }

  update(dt, cam) {
    this.body.visible = this.alive && !this.hidden && this.hasPos;
    if (!this.body.visible) return;
    const k = 1 - Math.exp(-dt * 12);
    const ox = this.px, oz = this.pz;
    this.px += (this.tx - this.px) * k; this.py += (this.ty - this.py) * k; this.pz += (this.tz - this.pz) * k;
    let d = this.tyaw - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, dt * 12);

    const spd = Math.hypot(this.px - ox, this.pz - oz) / Math.max(dt, 1e-4);
    this.speed += (spd - this.speed) * Math.min(1, dt * 8);
    const moving = this.speed > 0.5, sprint = this.speed > 8;

    this.body.position.set(this.px, this.py - 1.7, this.pz);
    this.body.rotation.y = this.yaw + Math.PI;

    // name tag: ukuran mengikuti jarak, disembunyikan jika terlalu dekat / terlalu jauh
    if (cam) {
      const d = Math.hypot(cam.position.x - this.px, cam.position.z - this.pz);
      this.tag.visible = d > 3 && d < 70;
      const k = Math.min(1.5, Math.max(0.5, d / 10));
      this.tag.scale.set(1.9 * k, 0.475 * k, 1);
    }

    const P = this.parts;
    if (moving) {
      this.walk += dt * (sprint ? 13 : 8.5);
      const legSwing = Math.sin(this.walk) * (sprint ? 0.62 : 0.40);
      P.leftLeg.rotation.x = -legSwing; P.rightLeg.rotation.x = legSwing;
      this.body.position.y -= Math.abs(Math.sin(this.walk * 2)) * (sprint ? 0.05 : 0.028);
    } else {
      P.leftLeg.rotation.x *= 0.85; P.rightLeg.rotation.x *= 0.85;
    }
    const pose = POSE[this.weapon] || POSE.rifle;
    P.rightArm.rotation.x = lerp(P.rightArm.rotation.x, pose.w[0], dt * 8);
    P.rightArm.rotation.z = lerp(P.rightArm.rotation.z, pose.w[1], dt * 8);
    P.leftArm.rotation.x = lerp(P.leftArm.rotation.x, pose.s[0], dt * 8);
    P.leftArm.rotation.z = lerp(P.leftArm.rotation.z, pose.s[1], dt * 8);
    if (!this.lite) {
      const w = this.weapon;
      if (P.gunTPP) P.gunTPP.visible = w === 'rifle';
      if (P.pistolTPP) P.pistolTPP.visible = w === 'pistol';
      if (P.smgTPP) P.smgTPP.visible = w === 'smg';
      if (P.katanaTPP) P.katanaTPP.visible = w === 'katana';
    }
  }

  dispose() {
    this.scene.remove(this.body);
    disposeSprite(this.tag);
    this.body.traverse(c => {
      if (c === this.tag) return;
      if (c.geometry) c.geometry.dispose();
      const m = c.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach(x => x.dispose && x.dispose());
    });
  }
}
