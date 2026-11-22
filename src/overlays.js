// overlays.js — layar login/daftar, leaderboard, hasil tim, banner spectator, error koneksi.
// Berdiri sendiri (tidak import ui.js) supaya tidak ada import melingkar.
import * as net from './net.js';

const FONT = "'Rajdhani',monospace";

function injectCss() {
  if (document.getElementById('ov-css')) return;
  const st = document.createElement('style'); st.id = 'ov-css';
  st.textContent = `
    .ov-input{user-select:text;-webkit-user-select:text;touch-action:manipulation}
    .ov-btn{font-size:18px;padding:11px 30px;color:#fff;border-radius:4px;letter-spacing:2px;font-weight:700;cursor:pointer;font-family:${FONT};border:2px solid #ff6666;background:#cc3333;touch-action:manipulation}
    .ov-btn:hover{background:#ee4444}
    .ov-btn.ghost{background:rgba(0,0,0,0.6);border-color:#777;color:#ccc}
    .ov-btn.ghost:hover{background:rgba(60,60,60,0.9)}
    .ov-btn:disabled{opacity:.5;cursor:wait}
    .ov-tab{flex:1;padding:10px;text-align:center;cursor:pointer;letter-spacing:3px;font-weight:700;color:#888;border-bottom:2px solid #333}
    .ov-tab.on{color:#00d4ff;border-color:#00d4ff}
    table.ov-t{border-collapse:collapse;color:#eee;font-family:${FONT};font-size:17px;min-width:min(560px,90vw)}
    table.ov-t th{color:#00d4ff;font-weight:600;letter-spacing:2px;padding:6px 14px;text-align:right;border-bottom:1px solid #345}
    table.ov-t td{padding:6px 14px;text-align:right}
    table.ov-t th:nth-child(1),table.ov-t td:nth-child(1),table.ov-t th:nth-child(2),table.ov-t td:nth-child(2){text-align:left}
    table.ov-t tr.me td{color:#ffd000;font-weight:700}
    @media (max-width: 600px), (max-height: 500px) {
      table.ov-t { font-size: 13px !important; min-width: 0 !important; width: 100% !important; }
      table.ov-t th, table.ov-t td { padding: 4px 6px !important; }
      .ov-btn { font-size: 15px !important; padding: 8px 18px !important; }
    }
  `;
  document.head.appendChild(st);
}

function layer(id, z = 60, bg = 'rgba(0,0,0,0.88)') {
  injectCss();
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div'); el.id = id;
    el.style.cssText = `position:fixed;inset:0;z-index:${z};display:none;align-items:center;justify-content:center;flex-direction:column;background:${bg};cursor:default;font-family:${FONT};overflow:auto;padding:16px;`;
    document.body.appendChild(el);
  }
  return el;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function btn(label, cls, onclick) {
  const b = document.createElement('button'); b.className = 'ov-btn ' + (cls || ''); b.textContent = label; b.onclick = onclick; return b;
}

// ───────── Login / Daftar ─────────
export function openAuth(onDone, onCancel) {
  const el = layer('authScreen', 60);
  el.innerHTML = '';
  let mode = 'login';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(360px,92vw);background:rgba(10,14,20,0.96);border:1px solid #2a3a4a;border-radius:10px;padding:22px;box-shadow:0 0 40px rgba(0,0,0,0.7);';
  box.innerHTML = `
    <div style="font-size:28px;font-weight:700;color:#ff4444;letter-spacing:5px;text-align:center;margin-bottom:14px">UNDEAD KINGDOM</div>
    <div style="display:flex;margin-bottom:16px"><div class="ov-tab on" data-m="login">LOGIN</div><div class="ov-tab" data-m="register">DAFTAR</div></div>
    <label style="color:#9ab;font-size:13px;letter-spacing:2px">ID</label>
    <input class="ov-input" id="authUser" maxlength="16" autocomplete="username" style="width:100%;margin:4px 0 12px;padding:10px;border-radius:5px;border:1px solid #345;background:#0b1118;color:#fff;font-size:17px;font-family:${FONT}">
    <label style="color:#9ab;font-size:13px;letter-spacing:2px">PASSWORD</label>
    <input class="ov-input" id="authPass" type="password" maxlength="64" autocomplete="current-password" style="width:100%;margin:4px 0 8px;padding:10px;border-radius:5px;border:1px solid #345;background:#0b1118;color:#fff;font-size:17px;font-family:${FONT}">
    <div id="authHint" style="color:#789;font-size:12px;min-height:16px;margin-bottom:6px">ID 3-16 karakter (huruf, angka, _)</div>
    <div id="authErr" style="color:#ff6666;font-size:14px;min-height:20px;margin-bottom:8px"></div>`;
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:center';
  const go = btn('MASUK', '', submit);
  const back = btn('BATAL', 'ghost', () => { el.style.display = 'none'; onCancel && onCancel(); });
  row.append(go, back); box.appendChild(row); el.appendChild(box);
  el.style.display = 'flex';

  const $ = id => box.querySelector(id);
  const tabs = box.querySelectorAll('.ov-tab');
  tabs.forEach(t => t.onclick = () => {
    mode = t.dataset.m;
    tabs.forEach(x => x.classList.toggle('on', x === t));
    go.textContent = mode === 'login' ? 'MASUK' : 'DAFTAR';
    $('#authErr').textContent = '';
    $('#authHint').style.visibility = mode === 'register' ? 'visible' : 'hidden';
    $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  });
  $('#authHint').style.visibility = 'hidden';
  box.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') submit(); });
  box.addEventListener('keyup', e => e.stopPropagation());
  setTimeout(() => $('#authUser').focus(), 50);

  async function submit() {
    const u = $('#authUser').value.trim(), p = $('#authPass').value;
    const err = $('#authErr'); err.textContent = '';
    if (!u || !p) { err.textContent = 'Isi ID dan password'; return; }
    go.disabled = true; go.textContent = '...';
    try {
      if (mode === 'login') await net.login(u, p); else await net.register(u, p);
      el.style.display = 'none';
      onDone && onDone();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      go.disabled = false; go.textContent = mode === 'login' ? 'MASUK' : 'DAFTAR';
    }
  }
}

// ───────── Leaderboard ─────────
export async function showLeaderboard(onClose) {
  const el = layer('lbScreen', 60);
  el.innerHTML = `<div style="font-size:34px;font-weight:700;color:#ffd000;letter-spacing:5px;margin-bottom:14px">🏆 LEADERBOARD</div><div id="lbBody" style="color:#aaa;font-size:16px;margin-bottom:20px">Memuat...</div>`;
  const close = btn('TUTUP', 'ghost', () => { el.style.display = 'none'; onClose && onClose(); });
  el.appendChild(close); el.style.display = 'flex';
  try {
    const list = await net.fetchLeaderboard();
    const me = net.session.user?.username;
    const body = el.querySelector('#lbBody');
    if (!list.length) { body.textContent = 'Belum ada skor. Jadilah yang pertama!'; return; }
    body.innerHTML = `<table class="ov-t"><tr><th>#</th><th>ID</th><th>HIGH SCORE</th><th>LANTAI</th><th>KILL</th><th>GAME</th></tr>` +
      list.map((u, i) => `<tr class="${u.username === me ? 'me' : ''}"><td>${i + 1}</td><td>${esc(u.username)}</td><td>${u.highScore.toLocaleString()}</td><td>${u.bestWave}</td><td>${u.totalKills}</td><td>${u.totalGames}</td></tr>`).join('') + '</table>';
  } catch (e) { el.querySelector('#lbBody').textContent = e.message; }
}

// ───────── Hasil tim ─────────
export function showTeamResult(data, myPid, onBack) {
  const el = layer('teamOver', 100, 'rgba(0,0,0,0.78)');
  const rows = [...data.results].sort((a, b) => b.score - a.score);
  el.innerHTML = `
    <div style="color:#ff4444;font-size:54px;font-weight:700;letter-spacing:6px;text-shadow:0 0 30px rgba(255,0,0,0.4);margin-bottom:6px">TIM GUGUR</div>
    <div style="color:#ddd;font-size:19px;letter-spacing:2px;margin-bottom:18px">Mencapai lantai <b style="color:#00d4ff">${data.wave}</b> · lantai diselesaikan <b style="color:#00ff88">${data.cleared}</b></div>
    <table class="ov-t"><tr><th>#</th><th>PEMAIN</th><th>SKOR</th><th>KILL</th></tr>${rows.map((r, i) =>
      `<tr class="${r.pid === myPid ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.score.toLocaleString()}</td><td>${r.kills}</td></tr>`).join('')}</table>
    <div id="teamMyBest" style="color:#ffd000;font-size:16px;letter-spacing:1px;margin:18px 0 20px;min-height:22px">Menyimpan statistik...</div>`;
  el.appendChild(btn('KEMBALI KE LOBBY', '', onBack));
  el.style.display = 'flex';
}
export function updateTeamBest(user) {
  const t = document.getElementById('teamMyBest');
  if (t && user) t.innerHTML = `🏆 Rekor kamu: <b>${user.highScore.toLocaleString()}</b> · lantai terbaik <b>${user.bestWave}</b> · total zombie dibunuh <b>${user.totalKills}</b> · ${user.totalGames} game`;
}
export function hideTeamResult() { const el = document.getElementById('teamOver'); if (el) el.style.display = 'none'; }

// ───────── Spectator banner ─────────
export function showSpectate(text) {
  injectCss();
  let el = document.getElementById('spectateBanner');
  if (!el) {
    el = document.createElement('div'); el.id = 'spectateBanner';
    el.style.cssText = `position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:30;pointer-events:none;text-align:center;font-family:${FONT};color:#fff;background:rgba(120,0,0,0.55);padding:8px 22px;border-radius:8px;letter-spacing:2px;font-size:17px;text-shadow:0 0 8px #000;`;
    document.body.appendChild(el);
  }
  el.textContent = text; el.style.display = 'block';
}
export function hideSpectate() { const el = document.getElementById('spectateBanner'); if (el) el.style.display = 'none'; }

// ───────── Error fatal / koneksi ─────────
export function showFatal(msg, label = 'MUAT ULANG', action = () => location.reload()) {
  const el = layer('fatalScreen', 200, 'rgba(0,0,0,0.92)');
  el.innerHTML = `<div style="color:#ff6666;font-size:26px;font-weight:700;letter-spacing:3px;margin-bottom:12px;text-align:center">${esc(msg)}</div>`;
  el.appendChild(btn(label, '', action));
  el.style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
}
