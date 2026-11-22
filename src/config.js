// config.js — pengaturan yang perlu Anda sesuaikan saat deploy.
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

let customServer = params.get('server');
if (customServer) {
  try { localStorage.setItem('uk_custom_server', customServer); } catch {}
} else {
  try { customServer = localStorage.getItem('uk_custom_server'); } catch {}
}

const PRODUCTION_SERVER_URL = 'https://GANTI-DENGAN-URL-SERVER-ANDA';

// Urutan prioritas: ?server=... di URL → localStorage → localhost saat dev → URL produksi
export const SERVER_URL = (
  customServer ||
  window.UNDEAD_SERVER_URL ||
  (isLocal ? 'http://localhost:3001' : PRODUCTION_SERVER_URL)
).replace(/\/$/, '');

export const SERVER_CONFIGURED = !SERVER_URL.includes('GANTI-DENGAN');

// Lokasi aset. Default: file lokal di folder public/.
// Jika file besar (map.glb) Anda taruh di CDN / Vercel Blob, ubah di sini.
export const ASSETS = {
  map:       './public/models/map.glb',
  zombie:    './public/models/zombie.glb',
  sky:       './public/models/sky.hdr',
  menuVideo: './public/menu_bg.mp4',
};

export const TOKEN_KEY = 'uk_token';
