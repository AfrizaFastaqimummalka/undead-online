@echo off
title Undead Online Server + Cloudflare Tunnel
cd /d "%~dp0"
node run-tunnel.js
pause
