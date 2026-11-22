import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, 'server');

console.log('\n============================================================');
console.log('    🧟 UNDEAD ONLINE - LAUNCHER CLOUDFLARE MULTIPLAYER');
console.log('============================================================\n');

console.log('[1/2] Menyalakan Server Game di port 3001...');

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const serverProc = spawn(npmCmd, ['run', 'dev'], {
  cwd: serverDir,
  stdio: ['inherit', 'pipe', 'pipe'],
  shell: true,
});

serverProc.stdout.on('data', data => {
  const line = data.toString().trim();
  if (line) console.log(`[server] ${line}`);
});

serverProc.stderr.on('data', data => {
  const line = data.toString().trim();
  if (line) console.error(`[server-err] ${line}`);
});

let tunnelFound = false;

setTimeout(() => {
  console.log('\n[2/2] Membuka Cloudflare Tunnel ke Internet...');

  const cloudflared = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3001'], {
    shell: true,
  });

  const handleTunnelOutput = chunk => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !tunnelFound) {
      tunnelFound = true;
      const tunnelUrl = match[0];
      const inviteUrl = `https://undead-online.vercel.app?server=${tunnelUrl}`;

      console.log('\n============================================================');
      console.log(' 🎉 SERVER MULTIPLAYER BERHASIL ONLINE DI INTERNET!');
      console.log('============================================================');
      console.log(` 🌐 Server Tunnel : ${tunnelUrl}`);
      console.log(` 🔗 LINK MABAR   : ${inviteUrl}`);
      console.log('============================================================');
      console.log(' 📋 Link mabar OTOMATIS DISALIN ke Clipboard! (Tinggal Ctrl + V)');
      console.log(' 🚀 Membuka game di browser Anda...\n');

      // Copy ke Clipboard Windows
      if (isWindows) {
        exec(`powershell -NoProfile -Command "Set-Clipboard -Value '${inviteUrl}'"`);
        exec(`powershell -NoProfile -Command "Start-Process '${inviteUrl}'"`);
      }

      console.log('💡 TIP: Kirim link di atas ke teman (WhatsApp / Discord).');
      console.log('   Tekan Ctrl + C di jendela ini kapan saja untuk mematikan server.\n');
    }
  };

  cloudflared.stdout.on('data', handleTunnelOutput);
  cloudflared.stderr.on('data', handleTunnelOutput);

  cloudflared.on('error', err => {
    console.error('[tunnel-err] Gagal menjalankan cloudflared:', err.message);
  });

  // Cleanup saat dimatikan
  const cleanup = () => {
    console.log('\nMematikan server dan tunnel...');
    try { cloudflared.kill(); } catch {}
    try { serverProc.kill(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}, 2500);
