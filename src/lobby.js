// lobby.js — scene lobby (lantai + 3 portal), pemain lain, HUD lobby, deteksi masuk portal.
import * as THREE from 'three';
import { state } from './state.js';
import * as net from './net.js';
import { RemotePlayer, makeLabelSprite, drawLabel } from './remote.js';

const lobbyGroup = new THREE.Group();
lobbyGroup.name = 'lobbyGroup';
lobbyGroup.visible = false;

let scene = null, cfg = null, built = false;
let portals = [];                 // [{cfg, group, swirl, label, lastKey}]
const remotes = new Map();        // id → RemotePlayer
let myId = -1;
let curPortal = null;             // portal yang sedang diikuti (antrean)
let lastQ = [[0, 0], [0, 0], [0, 0]];
let online = 1;
let hudEl = null, statusEl = null;
let t = 0;
let lastPx = 0, lastPz = 0, mismatchT = 0;

// ───────── Bangun scene ─────────
function gridTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#2b3038'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#3a414c'; g.lineWidth = 3; g.strokeRect(0, 0, 256, 256);
  g.strokeStyle = '#333a44'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(16, 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildLobby(s, config) {
  if (built) return;
  scene = s; cfg = config; built = true;
  const R = cfg.radius;

  const ground = new THREE.Mesh(new THREE.CircleGeometry(R, 64),
    new THREE.MeshStandardMaterial({ map: gridTexture(), emissive: 0xffffff, emissiveMap: gridTexture(), emissiveIntensity: 0.45, roughness: 0.9, metalness: 0.05 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = false;
  lobbyGroup.add(ground);

  const rim = new THREE.Mesh(new THREE.RingGeometry(R - 0.6, R, 64),
    new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  rim.rotation.x = -Math.PI / 2; rim.position.y = 0.02; lobbyGroup.add(rim);

  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 3, 64, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.95, side: THREE.DoubleSide }));
  wall.position.y = 1.5; lobbyGroup.add(wall);

  // pilar penerangan
  const pillarGeo = new THREE.CylinderGeometry(0.35, 0.45, 5, 10);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x20252d, roughness: 0.8 });
  const lampGeo = new THREE.SphereGeometry(0.32, 12, 8);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x66e0ff });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, r = R - 1.6;
    const p = new THREE.Mesh(pillarGeo, pillarMat); p.position.set(Math.cos(a) * r, 2.5, Math.sin(a) * r);
    const l = new THREE.Mesh(lampGeo, lampMat); l.position.set(p.position.x, 5.2, p.position.z);
    lobbyGroup.add(p, l);
  }

  // cincin pusat di titik spawn
  const spawnRing = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.5, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
  spawnRing.rotation.x = -Math.PI / 2; spawnRing.position.set(0, 0.02, 14); lobbyGroup.add(spawnRing);

  const title = makeLabelSprite('UNDEAD KINGDOM', { color: '#ff5555', sub: 'PILIH PORTAL UNTUK MULAI SURVIVAL', w: 768, h: 192, scaleX: 12 });
  title.position.set(0, 11.5, -26); lobbyGroup.add(title);

  // portal
  const faceTo = (x, z) => Math.atan2(cfg.spawn.x - x, cfg.spawn.z - z);
  portals = cfg.portals.map(pc => {
    const col = new THREE.Color(pc.color);
    const g = new THREE.Group(); g.position.set(pc.x, 0, pc.z); g.rotation.y = faceTo(pc.x, pc.z);

    const zone = new THREE.Mesh(new THREE.RingGeometry(cfg.portalRadius - 0.3, cfg.portalRadius, 48),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    zone.rotation.x = -Math.PI / 2; zone.position.y = 0.03; g.add(zone);
    const zoneFill = new THREE.Mesh(new THREE.CircleGeometry(cfg.portalRadius - 0.3, 48),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
    zoneFill.rotation.x = -Math.PI / 2; zoneFill.position.y = 0.025; g.add(zoneFill);

    const frame = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.17, 12, 48), new THREE.MeshBasicMaterial({ color: col }));
    frame.position.y = 2.5; g.add(frame);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1.88, 48),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    disc.position.y = 2.5; g.add(disc);
    const swirl = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.05, 8, 40, Math.PI * 1.5), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    swirl.position.set(0, 2.5, 0.02); g.add(swirl);

    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4.9, 0.35), new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.7 }));
      post.position.set(sx * 2.3, 2.45, 0); g.add(post);
    }
    const label = makeLabelSprite(pc.name, { color: pc.color, sub: '0/' + cfg.roomSize, w: 384, h: 128, scaleX: 4.2 });
    label.position.set(0, 5.6, 0); g.add(label);

    lobbyGroup.add(g);
    return { cfg: pc, group: g, swirl, disc, label, lastKey: '' };
  });

  scene.add(lobbyGroup);
  buildHud();
}

export function setLobbyVisible(v) { lobbyGroup.visible = v; if (hudEl) hudEl.style.display = v ? 'block' : 'none'; if (statusEl && !v) statusEl.style.display = 'none'; }
export function getLobbySpawn() { return cfg ? cfg.spawn : { x: 0, y: 1.7, z: 14 }; }

// ───────── HUD lobby ─────────
function buildHud() {
  hudEl = document.createElement('div');
  hudEl.id = 'lobbyHud';
  hudEl.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:21;display:none;pointer-events:none;text-align:center;font-family:Rajdhani,monospace;';
  hudEl.innerHTML = `
    <div style="font-size:20px;font-weight:700;letter-spacing:4px;color:#00d4ff;text-shadow:0 0 12px rgba(0,212,255,0.6)">LOBBY</div>
    <div id="lobbyOnline" style="font-size:14px;color:#ddd;letter-spacing:2px">1 / ${cfg.maxPlayers} pemain online</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.55);margin-top:4px;letter-spacing:1px">Masuk ke lingkaran portal untuk bergabung · <b>Enter</b> chat · <b>V</b> kamera</div>`;
  document.body.appendChild(hudEl);

  statusEl = document.createElement('div');
  statusEl.id = 'portalStatus';
  statusEl.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);z-index:21;display:none;pointer-events:none;text-align:center;font-family:Rajdhani,monospace;font-size:22px;font-weight:700;letter-spacing:2px;color:#fff;text-shadow:0 0 14px rgba(0,0,0,0.9);background:rgba(0,0,0,0.45);padding:10px 22px;border-radius:8px;';
  document.body.appendChild(statusEl);
}

function refreshStatus() {
  if (!statusEl) return;
  if (curPortal === null) { statusEl.style.display = 'none'; return; }
  const pc = cfg.portals[curPortal], [count, cd] = lastQ[curPortal];
  statusEl.style.display = 'block';
  statusEl.style.color = pc.color;
  statusEl.innerHTML = `${pc.name}: menunggu pemain ${count}/${cfg.roomSize}` +
    `<div style="font-size:15px;color:#fff;font-weight:600;margin-top:2px">Mulai dalam ${cd}s · keluar dari lingkaran untuk batal</div>`;
}

// ───────── Data dari server ─────────
export function resetLobbyState(myServerId) {
  myId = myServerId; curPortal = null; mismatchT = 0; lastQ = [[0, 0], [0, 0], [0, 0]];
  for (const r of remotes.values()) r.dispose();
  remotes.clear();
  refreshStatus();
}

export function onLobbyState(d) {
  online = d.o;
  const el = document.getElementById('lobbyOnline');
  if (el) el.textContent = `${d.p.length} di lobby · ${online} / ${cfg.maxPlayers} online`;
  const seen = new Set();
  for (const p of d.p) {
    if (p.i === myId) continue;
    seen.add(p.i);
    let r = remotes.get(p.i);
    if (!r) { r = new RemotePlayer(scene, { id: p.i, name: p.n, lite: true }); remotes.set(p.i, r); }
    r.setTarget(p.x, p.y, p.z, p.r);
  }
  for (const [id, r] of remotes) if (!seen.has(id)) { r.dispose(); remotes.delete(id); }

  // sinkronkan status antrean dengan server (mis. server mengeluarkan kita karena posisi tertinggal)
  const mine = d.p.find(p => p.i === myId);
  if (mine) {
    const serverPortal = mine.g;
    const clientPortal = curPortal === null ? -1 : curPortal;
    if (serverPortal !== clientPortal) {
      mismatchT += 0.1;
      if (mismatchT >= 0.8) {
        mismatchT = 0;
        if (clientPortal >= 0) {
          const po = cfg.portals[clientPortal];
          if (Math.hypot(lastPx - po.x, lastPz - po.z) < cfg.portalRadius) net.emit('portal:join', clientPortal);   // masih di dalam → minta ulang
          else { net.emit('portal:leave'); curPortal = null; refreshStatus(); }
        } else net.emit('portal:leave');                                  // server mengira kita antre, padahal tidak
      }
    } else mismatchT = 0;
  }

  lastQ = d.q;
  portals.forEach((po, i) => {
    const [count, cd] = d.q[i];
    const key = count + '|' + (count ? cd : 0);
    if (key !== po.lastKey) {
      po.lastKey = key;
      drawLabel(po.label, po.cfg.name, po.cfg.color, count ? `${count}/${cfg.roomSize} · ${cd}s` : `0/${cfg.roomSize}`);
    }
  });
  if (curPortal !== null) refreshStatus();
}

export function clearLobbyRemotes() {
  for (const r of remotes.values()) r.dispose();
  remotes.clear();
}

// ───────── Per-frame ─────────
let sendTimer = 0;
export function updateLobby(dt, camera) {
  t += dt;
  for (const r of remotes.values()) r.update(dt, camera);
  for (const p of portals) {
    p.swirl.rotation.z += dt * 2.2;
    p.disc.material.opacity = 0.28 + Math.sin(t * 2 + p.cfg.id) * 0.06;
  }

  // posisi ke server (10 Hz)
  sendTimer -= dt;
  if (sendTimer <= 0) {
    sendTimer = 0.1;
    net.emit('lobby:move', { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: state.yaw });
  }

  // deteksi masuk / keluar zona portal
  const px = camera.position.x, pz = camera.position.z;
  lastPx = px; lastPz = pz;
  if (curPortal === null) {
    for (const po of cfg.portals) {
      if (Math.hypot(px - po.x, pz - po.z) < cfg.portalRadius - 0.2) {
        curPortal = po.id; net.emit('portal:join', po.id); refreshStatus(); break;
      }
    }
  } else {
    const po = cfg.portals[curPortal];
    if (Math.hypot(px - po.x, pz - po.z) > cfg.portalRadius + 1.0) {
      net.emit('portal:leave'); curPortal = null; refreshStatus();
    }
  }
}

export function leftPortalQueue() { curPortal = null; refreshStatus(); }
