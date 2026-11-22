// config.js — pengaturan yang perlu Anda sesuaikan saat deploy.
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// ⚠️ GANTI baris di bawah dengan URL server Node.js Anda (Railway/Render/Fly.io), tanpa garis miring di akhir.
// Contoh: 'https://undead-kingdom-server.onrender.com'
const PRODUCTION_SERVER_URL = 'https://GANTI-DENGAN-URL-SERVER-ANDA';

// Urutan prioritas: ?server=... di URL (untuk uji coba) → localhost saat dev → URL produksi
export const SERVER_URL = (
  params.get('server') ||
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
