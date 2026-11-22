@echo off
title Undead Online Server + Cloudflare Tunnel
echo ========================================================
echo        UNDEAD ONLINE - MULTIPLAYER SERVER LAUNCHER
echo ========================================================
echo.

cd /d "%~dp0server"

echo [1/2] Menyalakan Server Node.js di Port 3001...
start "Undead Game Server" cmd /k "npm.cmd run dev"

timeout /t 3 >nul

echo [2/2] Membuka Cloudflare Tunnel ke Internet...
echo.
echo ========================================================
echo PERHATIKAN: Salin URL HTTPS yang berakhiran:
echo      .trycloudflare.com
echo.
echo Lalu buka atau kirim ke teman format link berikut:
echo      https://undead-online.vercel.app?server=URL_TRYCLOUDFLARE_ANDA
echo ========================================================
echo.

cloudflared tunnel --url http://localhost:3001
pause
