// fullscreen.js — Manajemen Fullscreen untuk HP & Desktop

export function isFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

export async function toggleFullscreen() {
  try {
    if (!isFullscreen()) {
      const el = document.documentElement;
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      } else if (el.msRequestFullscreen) {
        await el.msRequestFullscreen();
      }
      // Kunci orientasi ke lanskap di mobile bila didukung browser
      if (screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch (_) {}
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      } else if (document.msExitFullscreen) {
        await document.msExitFullscreen();
      }
    }
  } catch (err) {
    console.warn('[fullscreen] toggle error:', err);
  }
}

export function updateFullscreenUI() {
  const fs = isFullscreen();

  // Tombol di Lobby HUD
  const lobbyBtn = document.getElementById('btn-fullscreen-lobby');
  const lobbyIcon = document.getElementById('fs-lobby-icon');
  const lobbyText = document.getElementById('fs-lobby-text');
  if (lobbyBtn) {
    if (lobbyIcon) lobbyIcon.textContent = fs ? '🗗' : '⛶';
    if (lobbyText) lobbyText.textContent = fs ? 'KELUAR FULLSCREEN' : 'LAYAR PENUH';
    lobbyBtn.style.borderColor = fs ? 'rgba(255,180,0,0.7)' : 'rgba(0,212,255,0.6)';
    lobbyBtn.style.color = fs ? '#ffd000' : '#00d4ff';
  }

  // Tombol di Touch Controls (Mobile)
  const mobBtn = document.getElementById('btn-fullscreen-mobile');
  if (mobBtn) {
    mobBtn.textContent = fs ? '🗗' : '⛶';
    mobBtn.title = fs ? 'Keluar Fullscreen' : 'Layar Penuh';
  }

  // Trigger resize event agar canvas Three.js & camera langsung update ukurannya
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
  setTimeout(() => window.dispatchEvent(new Event('resize')), 350);
}

// Pasang listener global saat status fullscreen berubah
if (typeof document !== 'undefined') {
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
    document.addEventListener(evt, updateFullscreenUI);
  });
}
