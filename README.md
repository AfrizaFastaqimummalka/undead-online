# Undead Kingdom — Online Co-op

Game zombie survival 3D (Three.js) dengan **lobby online (maks 15 pemain)**, **3 portal** ke map survival
(co-op **3 pemain per room**), **chat**, **akun (ID + password)**, dan **statistik tersimpan di database Neon**.

```
Browser (Vercel, file statis)  ══ wss / https ══>  Server Node.js (Socket.IO + Express)  ──>  Neon (Postgres)
```

- **Client** (folder ini): render, input, suara, UI. Folder `src/`.
- **Server** (`server/`): akun, lobby, portal, room survival. **Server yang menjalankan zombie, wave, HP, skor, dan drop.**

## Alur game
`Login/Daftar → Lobby → masuk lingkaran portal → antre → room survival (3 pemain) → tim gugur → hasil → kembali ke lobby`

- Lobby maksimal **15 pemain online** (termasuk yang sedang berada di room). Pemain ke-16 ditolak.
- **3 portal**, masing-masing punya antrean sendiri. Room mulai saat **3 pemain** terkumpul, atau **20 detik** setelah pemain pertama masuk portal (boleh mulai dengan 1–2 pemain).
- Di room: jumlah zombie per wave diskalakan jumlah pemain. Pemain yang mati **menonton teman** (klik = ganti) dan **hidup lagi di wave berikutnya** dengan 60% HP. Jika semua mati bersamaan → game over tim.
- Statistik per akun: **high score, lantai (wave) tertinggi yang diselesaikan, total zombie dibunuh, total game**. Disimpan oleh server saat run selesai atau pemain keluar. Leaderboard di menu utama.
- Chat: **Enter** buka/kirim, **Esc** batal. Di lobby = semua pemain, di room = satu tim.

## 1. Menjalankan secara lokal
```bash
cd server
npm install
cp .env.example .env      # isi DATABASE_URL (Neon) dan JWT_SECRET
npm start                 # server di http://localhost:3001
```
Tanpa `DATABASE_URL`, server memakai **memori** (data hilang saat restart) — cukup untuk mencoba.

Lalu sajikan folder game (root) dengan web server statis apa pun, misalnya:
```bash
npx serve .      # atau: python3 -m http.server 8000
```
Buka halamannya di **2 tab/browser** (daftar dengan ID berbeda) dan masuk ke portal yang sama.
Di `localhost` client otomatis memakai server `http://localhost:3001`.

## 2. Neon (database)
1. Buat project di https://neon.tech → salin **Connection string** (`postgresql://...?sslmode=require`).
2. Tempel ke `DATABASE_URL` di `server/.env` (atau Environment Variables di hosting).
3. Tabel `users` dibuat otomatis saat server start (lihat juga `server/schema.sql`).

## 3. Deploy
**Server** (butuh proses Node yang terus hidup — *tidak bisa* di Vercel serverless): Railway, Render, atau Fly.io.
Pilih region **Singapore**. Isi environment variable:

| Variable | Isi |
|---|---|
| `DATABASE_URL` | connection string Neon |
| `JWT_SECRET` | string acak panjang (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `CLIENT_ORIGIN` | domain Vercel Anda, mis. `https://nama-game.vercel.app` |

Start command: `npm start` (root directory: `server`). Server harus memakai HTTPS/WSS (hosting menyediakannya otomatis).
Cek `https://URL-SERVER/health`. Catatan: free tier sering "tertidur" saat sepi — koneksi pertama bisa butuh ±30 detik.

**Client** (Vercel): deploy folder root sebagai situs statis. **Edit `src/config.js`** → isi `PRODUCTION_SERVER_URL` dengan URL server.
Disarankan menambah `.vercelignore` berisi `server/` agar folder server tidak ikut dipublikasikan.
File `public/models/map.glb` (±32 MB) terlalu besar untuk upload lewat web GitHub (batas 25 MB) — gunakan `git push`.

## 4. Tes otomatis
```bash
cd server && npm test
```
Tiga rangkaian tes (43 pemeriksaan):
- `room.unit.test.js` — logika room: wave & intermission, wave boss, revive, game over, penyimpanan statistik (tepat sekali), pemain keluar saat main, drop, validasi tembakan, input sampah.
- `integration.test.js` — akun, lobby, portal, room, tembakan, game over, statistik persisten, login ganda, batas 15 pemain.
- `flow.test.js` — antrean sendirian, batal antre, 3 portal terpisah, disconnect / login ganda saat di room, payload sampah.

## Struktur
```
src/
  config.js    URL server & lokasi aset (EDIT saat deploy)
  net.js       koneksi REST + Socket.IO
  session.js   alur Login → Lobby → Room → Hasil
  lobby.js     scene lobby, 3 portal, HUD lobby
  remote.js    avatar pemain lain + name tag
  chat.js      chat
  overlays.js  login/daftar, leaderboard, layar hasil, spectator
  zombies.js   RENDERER zombie dari snapshot server
  (game.js, ui.js, player.js, weapons.js, world.js, ...) game asli, diadaptasi
server/src/
  index.js     entry (Express + Socket.IO)
  auth.js db.js  akun + Neon
  lobby.js     lobby & portal
  room.js      simulasi survival (zombie, wave, HP, drop, statistik)
```

## Batasan (tahap uji coba)
- **Hit detection**: client yang membidik, server memvalidasi (jarak & kecepatan tembak). Belum kebal cheat penuh.
- Jumlah peluru/reload dan hujan (tombol **F**) hanya lokal. Semua pemain memakai karakter & senjata yang sama.
- Posisi pemain dipercaya dari client (dengan batas area). Belum ada validasi kecepatan.
- Password minimal 4 karakter (sengaja sederhana); di-hash dengan bcrypt, login dibatasi per IP.
- Belum diuji performa pada HP kelas rendah dengan 15 pemain di lobby.
