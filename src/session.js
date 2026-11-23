// session.js — pengatur alur online: Login → Lobby → Room survival → Hasil → Lobby.
// Menghubungkan event server dengan scene, HUD, zombie renderer, dan avatar tim.
import { state } from './state.js';
import * as net from './net.js';
import { setWorldMode, setMapVisible, PLAYER_SPAWN } from './world.js';
import { buildLobby, setLobbyVisible, resetLobbyState, onLobbyState, clearLobbyRemotes, updateLobby } from './lobby.js';
import { RemotePlayer } from './remote.js';
import { netApplyZombies, netZombieDie, netSpawnDrop, netRemoveDrop, clearAllZombies, clearDrops } from './zombies.js';
import { updateHUD, showMessage, hideMessage, showDamageOverlay, setGameHudVisible } from './ui.js';
import { switchWeapon, refreshWallCache } from './weapons.js';
import { initChat, setChatVisible, clearChat, addSystem } from './chat.js';
import { showTeamResult, updateTeamBest, hideTeamResult, showSpectate, hideSpectate, showFatal } from './overlays.js';
import { playZombieAttack, playPlayerHurt, playPickup, playLobbyMusic, playRoomMusic, stopAllMusic, playGunshot } from './audio.js';
import { getPing } from './net.js';

let scene = null, camera = null, lockPointer = () => {};
const remotes = new Map();       // pid → RemotePlayer (teman satu tim)
let myPid = 0;
let sendTimer = 0, panelTimer = 0, hudKey = '', specIdx = 0;
let panel = null;
let scoreboardVisible = false;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initSession(s, cam, lockFn) {
  scene = s; camera = cam; lockPointer = lockFn;
  initChat(lockFn);

  net.on('lobby:init', onLobbyInit);
  net.on('lobby:state', d => { if (state.mode === 'lobby') onLobbyState(d); });
  net.on('match:start', enterSurvival);
  net.on('room:snap', onSnap);
  net.on('room:ev', onRoomEv);
  net.on('room:hurt', onHurt);
  net.on('room:pickup', onPickup);
  net.on('room:over', onOver);
  net.on('me:stats', d => updateTeamBest(d.user));
  net.on('kicked', () => showFatal('Akun ini login dari tempat lain.'));
  net.on('disconnect', reason => { if (reason !== 'io client disconnect') showFatal('Koneksi ke server terputus.'); });

  document.addEventListener('mousedown', e => { if (e.button === 0 && state.spectating) specIdx++; });

  // ── Tab Scoreboard ──
  document.addEventListener('keydown', e => {
    if (e.code === 'Tab' && state.mode === 'survival') {
      e.preventDefault();
      scoreboardVisible = true;
      renderScoreboard();
      const sb = document.getElementById('scoreboard');
      if (sb) sb.style.display = 'flex';
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Tab') {
      scoreboardVisible = false;
      const sb = document.getElementById('scoreboard');
      if (sb) sb.style.display = 'none';
    }
  });
}

/** Dipanggil dari tombol "MASUK LOBBY" (gesture pengguna). */
export async function startOnline() {
  showMessage('Menghubungkan ke server...');
  try {
    await net.connect();
  } catch (e) {
    hideMessage();
    showFatal(e.message, 'KEMBALI');
  }
}

// ───────────────── LOBBY ─────────────────
function onLobbyInit(init) {
  hideMessage();
  state.mode = 'lobby';
  state.teamOver = false;
  setWorldMode('lobby'); setMapVisible(false);
  buildLobby(scene, init);
  setLobbyVisible(true);
  resetLobbyState(init.id);
  clearSurvivalState();

  camera.position.set(init.spawn.x, 1.7, init.spawn.z);
  state.yaw = 0; state.pitch = 0;
  state.player.health = state.player.maxHealth;
  state.player.isDead = false; state.player.velocityY = 0; state.player.isGrounded = true;
  state.spectating = false;
  hideTeamResult(); hideSpectate();
  const f = document.getElementById('fatalScreen'); if (f) f.style.display = 'none';
  setGameHudVisible(false);
  setChatVisible(true, 'Lobby');
  addSystem('Selamat datang di lobby! Masuk ke portal untuk bermain bersama.', '#00d4ff');
  playLobbyMusic();
}

// ───────────────── ROOM SURVIVAL ─────────────────
function resetLoadout() {
  const w = state.weapons;
  w.pistol.ammo = w.pistol.maxAmmo; w.pistol.reserve = 60;  w.pistol.isReloading = false;
  w.rifle.ammo  = w.rifle.maxAmmo;  w.rifle.reserve  = 90;  w.rifle.isReloading  = false;
  w.smg.ammo    = w.smg.maxAmmo;    w.smg.reserve    = 105; w.smg.isReloading   = false;
  w.katana.isReloading = false;
  state.currentWeapon = 'pistol';
  switchWeapon('rifle');
  state.cameraMode = 'FPP';
}

function clearSurvivalState() {
  clearAllZombies(); clearDrops();
  for (const r of remotes.values()) r.dispose();
  remotes.clear();
  state.team = [];
  state.score = 0; state.kills = 0;
  state.wave = 0; state.waveZombieCount = 0; state.waveZombiesKilled = 0;
  state.waveActive = false; state.intermission = 0;
  state.boss.active = false;
  hudKey = '';
  if (panel) panel.style.display = 'none';
}

function enterSurvival(m) {
  clearLobbyRemotes();
  clearSurvivalState();
  state.mode = 'survival';
  state.teamOver = false; state.spectating = false;
  setWorldMode('survival'); setMapVisible(true); setLobbyVisible(false);
  // Bangun cache wall objects untuk wall raycast (menggantikan scene.traverse per tembak)
  refreshWallCache();
  myPid = m.pid; state.pid = m.pid;

  state.player.maxHealth = m.maxHp; state.player.health = m.maxHp;
  state.player.isDead = false; state.player.velocityY = 0; state.player.isGrounded = true;
  state.shakeIntensity = 0; state.damageTimer = 0;
  resetLoadout();
  camera.position.set(m.spawn.x, PLAYER_SPAWN.y, m.spawn.z);
  state.yaw = 0; state.pitch = 0;

  for (const p of m.players) {
    if (p.pid === myPid) continue;
    remotes.set(p.pid, new RemotePlayer(scene, { id: p.pid, name: p.name, lite: false, color: '#7dffb0' }));
  }
  state.team = m.players.map(p => ({ pid: p.pid, name: p.name, x: 0, z: 0, hp: m.maxHp, alive: true, me: p.pid === myPid, score: 0, kills: 0 }));

  hideTeamResult(); hideSpectate();
  setGameHudVisible(true);
  setChatVisible(true, 'Tim'); clearChat();
  addSystem('Tim: ' + m.players.map(p => p.name).join(', '), '#7dffb0');
  showMessage('Bersiap...'); updateHUD();
  buildPanel();
  buildScoreboard();
  playRoomMusic();
}

function onSnap(d) {
  if (state.mode !== 'survival') return;
  const w = d.w, b = state.boss;
  state.wave = w.n; state.waveZombieCount = w.c; state.waveZombiesKilled = w.k;
  state.waveActive = !!w.a; state.intermission = w.i;
  if (w.b) { b.active = true; b.health = w.b[0]; b.maxHealth = w.b[1]; } else b.active = false;
  if (w.n === 0 && w.d > 0) showMessage(`Bersiap... ${w.d}`);

  const seen = new Set(); let me = null;
  state.team = [];
  for (const p of d.p) {
    seen.add(p.i);
    if (p.i === myPid) me = p;
    else {
      let r = remotes.get(p.i);
      if (!r) { r = new RemotePlayer(scene, { id: p.i, name: p.n, lite: false, color: '#7dffb0' }); remotes.set(p.i, r); }
      r.setTarget(p.x, p.y, p.z, p.r, p.w);
      r.setAlive(!!p.a);
    }
    state.team.push({ pid: p.i, name: p.n, x: p.x, z: p.z, hp: p.h, alive: !!p.a, me: p.i === myPid, score: p.s || 0, kills: p.k || 0 });
  }
  for (const [pid, r] of remotes) if (!seen.has(pid)) { r.dispose(); remotes.delete(pid); }

  if (me) {
    state.player.health = me.h; state.score = me.s; state.kills = me.k;
    if (!me.a && !state.player.isDead) onLocalDeath();
    else if (me.a && state.player.isDead) onRevive(me);
  }
  netApplyZombies(d.z);

  const key = [me ? me.h : 0, state.score, state.kills, w.n, w.c, w.k, w.a, w.i, w.b ? w.b[0] : 0].join('|');
  if (key !== hudKey) { hudKey = key; updateHUD(); }
}

function onRoomEv(ev) {
  if (state.mode !== 'survival') return;
  switch (ev.k) {
    case 'wave': showMessage(`Wave ${ev.n}`); setTimeout(hideMessage, 2000); break;
    case 'wavedone': showMessage(`Wave ${ev.n} Complete! ✓`); setTimeout(hideMessage, 2500); break;
    case 'boss': showMessage('⚠️ KING ZOMBIE APPEARS!'); setTimeout(hideMessage, 3000); break;
    case 'zdie':
      netZombieDie(ev);
      if (ev.t === 'boss') { showMessage('💀 KING ZOMBIE DEFEATED!'); setTimeout(hideMessage, 3000); }
      break;
    case 'drop': netSpawnDrop(ev); break;
    case 'dropgone': netRemoveDrop(ev.id); break;
    case 'pdie': {
      if (ev.pid !== myPid) { const t = state.team.find(x => x.pid === ev.pid); addSystem(`${t ? t.name : 'Teman'} gugur`, '#ff8888'); }
      break;
    }
    case 'pleave': addSystem(`${ev.name} keluar dari tim`, '#ffd000'); break;
    case 'shoot':
      // Suara tembakan pemain lain (Bug 3 fix)
      if (ev.pid !== myPid) playGunshot(ev.w);
      break;
    case 'revive': showMessage('Hidup kembali! ❤️'); setTimeout(hideMessage, 1800); break;
  }
}

function onHurt(d) {
  if (state.mode !== 'survival') return;
  state.player.health = d.hp;
  showDamageOverlay('rgba(255,0,0,0.5)');
  playZombieAttack(); playPlayerHurt();
  state.shakeIntensity = Math.max(state.shakeIntensity, 0.06);
  updateHUD();
}

function onPickup(d) {
  if (state.mode !== 'survival') return;
  if (d.type === 'health') {
    state.player.health = d.hp;
  } else {
    const ws = state.weapons, bonus = d.value;
    if (ws.pistol.reserve < 120) ws.pistol.reserve = Math.min(120, ws.pistol.reserve + Math.floor(bonus * 0.5));
    if (ws.rifle.reserve < 180) ws.rifle.reserve = Math.min(180, ws.rifle.reserve + bonus);
    if (ws.smg.reserve < 210) ws.smg.reserve = Math.min(210, ws.smg.reserve + Math.floor(bonus * 1.5));
  }
  showDamageOverlay(d.type === 'health' ? 'rgba(0,255,0,0.3)' : 'rgba(255,170,0,0.3)');
  playPickup(d.type);
  updateHUD();
}

function onLocalDeath() {
  state.player.isDead = true; state.spectating = true; specIdx = 0;
  showDamageOverlay('rgba(255,0,0,0.5)');
  window.__clearKeys && window.__clearKeys();
}
function onRevive(me) {
  state.player.isDead = false; state.spectating = false;
  for (const r of remotes.values()) r.setHidden(false);
  hideSpectate();
  camera.position.set(me.x, me.y, me.z);
  state.player.velocityY = 0;
  updateHUD();
}

function onOver(d) {
  state.teamOver = true; state.spectating = false;
  hideSpectate(); setChatVisible(false);
  stopAllMusic();
  showTeamResult(d, myPid, backToLobby);
  if (document.pointerLockElement) document.exitPointerLock();
}

/** Tombol "KEMBALI KE LOBBY" di layar hasil (gesture pengguna → boleh minta pointer lock). */
export function backToLobby() {
  hideTeamResult();
  lockPointer();
  playLobbyMusic();
  net.emit('room:leave');
}
/** Dari menu pause saat sedang di room. */
export function leaveToLobby() {
  playLobbyMusic();
  net.emit('room:leave');
}
export function logoutGame() {
  net.logout();
  location.reload();
}

// ───────────────── PER FRAME ─────────────────
export function updateSession(dt) {
  if (state.mode === 'lobby') {
    updateLobby(dt, camera);
  } else if (state.mode === 'survival') {
    for (const r of remotes.values()) r.update(dt, camera);

    sendTimer -= dt;
    if (sendTimer <= 0 && !state.player.isDead && !state.teamOver) {
      sendTimer = 0.05;
      net.emit('room:move', { x: camera.position.x, y: camera.position.y, z: camera.position.z,
                              yaw: state.yaw, pitch: state.pitch, w: state.currentWeapon });
    }
    if (state.spectating && !state.teamOver) spectateStep();

    panelTimer -= dt;
    if (panelTimer <= 0) {
      panelTimer = 0.25;
      renderPanel();
      if (scoreboardVisible) renderScoreboard();
    }
  }
}

function spectateStep() {
  if (state.teamOver) { hideSpectate(); return; }
  const alive = [...remotes.values()].filter(r => r.alive && r.hasPos);
  if (!alive.length) { showSpectate('Menunggu wave berikutnya...'); return; }
  const t = alive[((specIdx % alive.length) + alive.length) % alive.length];
  for (const r of remotes.values()) r.setHidden(r === t);     // sembunyikan avatar yang sedang ditonton
  camera.position.set(t.px, t.py, t.pz);
  state.yaw = t.yaw; state.pitch = 0;
  state.player.x = t.px; state.player.z = t.pz;
  showSpectate(`Kamu gugur — menonton ${t.name}  (klik untuk ganti) · hidup lagi di wave berikutnya`);
}

// ───────────────── Panel tim ─────────────────
function buildPanel() {
  if (panel) return;
  panel = document.createElement('div');
  panel.id = 'teamPanel';
  panel.style.cssText = 'position:fixed;top:14px;right:14px;z-index:21;pointer-events:none;font-family:Rajdhani,monospace;min-width:150px;display:none;';
  document.body.appendChild(panel);
}
function renderPanel() {
  if (!panel) return;
  if (state.mode !== 'survival' || state.team.length < 2) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const max = state.player.maxHealth || 100;
  panel.innerHTML = state.team.map(t => {
    const pct = Math.max(0, Math.min(100, (t.hp / max) * 100));
    const col = !t.alive ? '#555' : pct > 60 ? '#00ff88' : pct > 30 ? '#ffd000' : '#ff3a3a';
    return `<div style="margin-bottom:6px;color:${t.me ? '#ffd000' : '#fff'};text-shadow:0 0 6px #000;font-size:14px;letter-spacing:1px">
      ${esc(t.name)}${t.alive ? '' : ' ☠'}
      <div style="height:6px;background:rgba(255,255,255,0.15);border-radius:3px;overflow:hidden"><div style="height:100%;width:${t.alive ? pct : 0}%;background:${col}"></div></div></div>`;
  }).join('');
}

// ───────────────── Scoreboard Tab ─────────────────
function pingColor(ms) {
  if (ms <= 0) return '#888';
  if (ms < 60)  return '#00ff88';
  if (ms < 120) return '#ffd000';
  if (ms < 200) return '#ff9900';
  return '#ff3a3a';
}
function pingLabel(ms) {
  if (ms <= 0) return '—';
  if (ms < 60)  return 'Bagus';
  if (ms < 120) return 'Normal';
  if (ms < 200) return 'Lag';
  return 'Buruk';
}

function buildScoreboard() {
  if (document.getElementById('scoreboard')) return;
  // Inject CSS scoreboard
  if (!document.getElementById('scoreboard-css')) {
    const style = document.createElement('style');
    style.id = 'scoreboard-css';
    style.textContent = `
      #scoreboard {
        display: none;
        position: fixed; inset: 0; z-index: 100;
        align-items: center; justify-content: center;
        pointer-events: none;
        background: rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        font-family: 'Rajdhani', monospace;
      }
      #scoreboard-inner {
        min-width: 540px; max-width: 700px; width: 90vw;
        background: rgba(10,15,25,0.95);
        border: 1px solid rgba(0,212,255,0.25);
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 0 40px rgba(0,0,0,0.8), 0 0 20px rgba(0,212,255,0.08);
      }
      #scoreboard-header {
        background: rgba(0,212,255,0.08);
        border-bottom: 1px solid rgba(0,212,255,0.2);
        padding: 14px 24px;
        display: flex; align-items: center; justify-content: space-between;
      }
      #scoreboard-header .sb-title {
        font-size: 18px; font-weight: 700; letter-spacing: 4px;
        color: #00d4ff; text-transform: uppercase;
      }
      #scoreboard-header .sb-wave {
        font-size: 13px; color: rgba(255,255,255,0.5); letter-spacing: 2px;
      }
      #scoreboard-header .sb-hint {
        font-size: 11px; color: rgba(255,255,255,0.3); letter-spacing: 1px;
      }
      #scoreboard-cols {
        display: grid;
        grid-template-columns: 1fr 80px 80px 80px 110px;
        padding: 8px 24px 6px;
        font-size: 10px; font-weight: 600; letter-spacing: 2px;
        color: rgba(255,255,255,0.3); text-transform: uppercase;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      #scoreboard-rows { padding: 8px 0 12px; }
      .sb-row {
        display: grid;
        grid-template-columns: 1fr 80px 80px 80px 110px;
        padding: 10px 24px;
        align-items: center;
        transition: background 0.15s;
      }
      .sb-row.sb-me {
        background: rgba(0,212,255,0.06);
        border-left: 3px solid #00d4ff;
        padding-left: 21px;
      }
      .sb-row.sb-dead { opacity: 0.45; }
      .sb-name {
        display: flex; align-items: center; gap: 10px;
        font-size: 15px; font-weight: 600; color: #fff;
        letter-spacing: 1px; overflow: hidden;
      }
      .sb-name .sb-avatar {
        width: 28px; height: 28px; border-radius: 50%;
        background: rgba(255,255,255,0.1);
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; flex-shrink: 0;
      }
      .sb-name .sb-me-tag {
        font-size: 10px; color: #00d4ff; letter-spacing: 2px;
        background: rgba(0,212,255,0.12); padding: 1px 6px; border-radius: 3px;
      }
      .sb-name .sb-dead-tag {
        font-size: 10px; color: #ff3a3a; letter-spacing: 2px;
        background: rgba(255,58,58,0.12); padding: 1px 6px; border-radius: 3px;
      }
      .sb-cell {
        font-size: 15px; font-weight: 600; color: #fff;
        text-align: right; letter-spacing: 0.5px;
      }
      .sb-cell .sb-sub {
        font-size: 10px; color: rgba(255,255,255,0.3);
        letter-spacing: 1px; display: block;
      }
      .sb-ping-bar {
        display: flex; align-items: center; justify-content: flex-end; gap: 8px;
      }
      .sb-ping-val {
        font-size: 15px; font-weight: 700; min-width: 42px; text-align: right;
      }
      .sb-ping-label {
        font-size: 10px; letter-spacing: 1px; opacity: 0.75;
      }
      #scoreboard-footer {
        border-top: 1px solid rgba(255,255,255,0.05);
        padding: 10px 24px;
        display: flex; align-items: center; justify-content: space-between;
        font-size: 11px; color: rgba(255,255,255,0.3); letter-spacing: 1px;
      }
      @media (max-width: 768px), (max-height: 520px), (pointer: coarse) {
        #scoreboard { pointer-events: auto !important; }
        #scoreboard-inner {
          min-width: 0 !important; max-width: 95vw !important; width: 95vw !important;
          max-height: 85vh !important; overflow-y: auto !important;
        }
        #scoreboard-header { padding: 8px 14px !important; }
        #scoreboard-cols, .sb-row {
          grid-template-columns: 1fr 65px 50px 50px 65px !important;
          padding: 8px 12px !important;
        }
        .sb-name { font-size: 13px !important; gap: 6px !important; }
        .sb-name .sb-avatar { width: 22px !important; height: 22px !important; font-size: 11px !important; }
        .sb-cell { font-size: 13px !important; }
        .sb-ping-label { display: none !important; }
        #scoreboard-footer { padding: 8px 12px !important; font-size: 10px !important; }
      }
    `;
    document.head.appendChild(style);
  }

  const sb = document.createElement('div');
  sb.id = 'scoreboard';
  sb.innerHTML = `
    <div id="scoreboard-inner">
      <div id="scoreboard-header">
        <span class="sb-title">📊 Scoreboard</span>
        <span class="sb-wave" id="sb-wave-info">Wave 1</span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="sb-hint">TAB</span>
          <span id="sb-close-btn" style="cursor:pointer;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.1);color:#fff;font-size:14px;pointer-events:auto;">✕</span>
        </div>
      </div>
      <div id="scoreboard-cols">
        <div>Pemain</div>
        <div style="text-align:right">Score</div>
        <div style="text-align:right">Kills</div>
        <div style="text-align:right">HP</div>
        <div style="text-align:right">Ping</div>
      </div>
      <div id="scoreboard-rows"></div>
      <div id="scoreboard-footer">
        <span id="sb-server-info">Server: Undead Kingdom</span>
        <span id="sb-online-info">Online: 1</span>
      </div>
    </div>
  `;
  sb.addEventListener('click', e => {
    if (e.target === sb || e.target.id === 'sb-close-btn') {
      window.toggleScoreboard(false);
    }
  });
  document.body.appendChild(sb);
}

window.toggleScoreboard = (force) => {
  scoreboardVisible = (force !== undefined) ? force : !scoreboardVisible;
  const sb = document.getElementById('scoreboard');
  if (sb) {
    sb.style.display = scoreboardVisible ? 'flex' : 'none';
    sb.style.pointerEvents = scoreboardVisible ? 'auto' : 'none';
    if (scoreboardVisible) renderScoreboard();
  }
  return scoreboardVisible;
};

function renderScoreboard() {
  const sb = document.getElementById('scoreboard');
  if (!sb || !scoreboardVisible) return;

  const myPing = getPing();

  // Update wave info
  const waveEl = document.getElementById('sb-wave-info');
  if (waveEl) {
    if (state.waveActive) waveEl.textContent = `Wave ${state.wave}  —  ${state.waveZombiesKilled}/${state.waveZombieCount} Zombie`;
    else if (state.intermission > 0) waveEl.textContent = `Wave ${state.wave} Selesai  —  Next in ${Math.ceil(state.intermission)}s`;
    else waveEl.textContent = `Wave ${state.wave}`;
  }

  // Online count from health panel (approximate from team size)
  const onlineEl = document.getElementById('sb-online-info');
  if (onlineEl) onlineEl.textContent = `Tim: ${state.team.length} pemain`;

  // Rows
  const rowsEl = document.getElementById('scoreboard-rows');
  if (!rowsEl) return;

  // Sort by score descending
  const sorted = [...state.team].sort((a, b) => (b.score || 0) - (a.score || 0));
  const max = state.player.maxHealth || 100;

  rowsEl.innerHTML = sorted.map((t, rank) => {
    const isMe = t.me || t.pid === myPid;
    const hp = Math.max(0, t.hp);
    const hpPct = Math.max(0, Math.min(100, (hp / max) * 100));
    const hpColor = !t.alive ? '#555' : hpPct > 60 ? '#00ff88' : hpPct > 30 ? '#ffd000' : '#ff3a3a';
    const score = t.score || 0;
    const kills = t.kills || 0;
    const ms = isMe ? myPing : 0;  // hanya ping kita yang diketahui client
    const pc = pingColor(ms);
    const pl = pingLabel(ms);
    const rankEmoji = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '👤';

    return `<div class="sb-row${isMe ? ' sb-me' : ''}${!t.alive ? ' sb-dead' : ''}">
      <div class="sb-name">
        <div class="sb-avatar">${rankEmoji}</div>
        <span>${esc(t.name)}</span>
        ${isMe ? '<span class="sb-me-tag">KAMU</span>' : ''}
        ${!t.alive ? '<span class="sb-dead-tag">☠ GUGUR</span>' : ''}
      </div>
      <div class="sb-cell">${score.toLocaleString()}<span class="sb-sub">SCORE</span></div>
      <div class="sb-cell">${kills}<span class="sb-sub">KILLS</span></div>
      <div class="sb-cell" style="color:${hpColor}">${t.alive ? Math.ceil(hp) : '—'}<span class="sb-sub">HP</span></div>
      <div class="sb-cell">
        ${isMe
          ? `<div class="sb-ping-bar"><span class="sb-ping-val" style="color:${pc}">${ms > 0 ? ms + 'ms' : '—'}</span><span class="sb-ping-label" style="color:${pc}">${pl}</span></div>`
          : `<div class="sb-ping-bar"><span class="sb-ping-val" style="color:#555">—</span><span class="sb-ping-label" style="color:#555">-</span></div>`
        }
      </div>
    </div>`;
  }).join('');
}
