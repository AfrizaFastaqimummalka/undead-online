// chat.js — chat sederhana (lobby = semua pemain, room = satu tim). Enter untuk membuka/mengirim.
import { state } from './state.js';
import * as net from './net.js';
import { showPause } from './ui.js';

let wrap, log, inputRow, input, sendBtn, btn;
let scopeLabel = 'Lobby';
const isTouch = 'ontouchstart' in window;
const MAX_LINES = 40;
let chatLockPointer = null;

export function initChat(lockPointer) {
  if (wrap) return;
  chatLockPointer = lockPointer;
  wrap = document.createElement('div');
  wrap.id = 'chatBox';
  wrap.style.cssText = `position:fixed;left:14px;bottom:${isTouch ? 175 : 190}px;width:min(340px,70vw);z-index:22;
    font-family:Rajdhani,monospace;font-size:14px;display:none;pointer-events:none;`;
  log = document.createElement('div');
  log.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:hidden;justify-content:flex-end;';
  
  inputRow = document.createElement('div');
  inputRow.id = 'chatInputRow';
  inputRow.style.cssText = 'display:none;width:100%;margin-top:6px;gap:6px;align-items:center;pointer-events:auto;';

  input = document.createElement('input');
  input.type = 'text'; input.maxLength = 120; input.autocomplete = 'off'; input.spellcheck = false;
  input.placeholder = isTouch ? 'Ketik pesan...' : 'Ketik pesan, Enter = kirim, Esc = batal';
  input.style.cssText = `flex:1;min-width:0;padding:7px 10px;border-radius:6px;border:1px solid #00d4ff;
    background:rgba(0,0,0,0.85);color:#fff;font-family:inherit;font-size:15px;outline:none;`;

  sendBtn = document.createElement('button');
  sendBtn.textContent = '➤';
  sendBtn.id = 'btn-chat-send';
  sendBtn.style.cssText = `width:38px;height:34px;border-radius:6px;border:1px solid #00d4ff;background:rgba(0,212,255,0.25);
    color:#fff;font-size:16px;cursor:pointer;display:${isTouch ? 'flex' : 'none'};align-items:center;justify-content:center;touch-action:manipulation;`;
  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeChat(true);
  });

  inputRow.append(input, sendBtn);
  wrap.append(log, inputRow);
  document.body.appendChild(wrap);

  if (isTouch) {
    btn = document.createElement('button');
    btn.textContent = '💬';
    btn.id = 'btn-chat-mobile';
    btn.style.cssText = 'position:fixed;top:12px;right:110px;z-index:35;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.55);color:#fff;font-size:18px;display:none;align-items:center;justify-content:center;touch-action:manipulation;box-shadow:0 4px 10px rgba(0,0,0,0.5);';
    btn.addEventListener('click', () => (state.chatOpen ? closeChat(false) : openChat()));
    document.body.appendChild(btn);
  }

  net.on('chat:msg', m => addMessage(m.scope === 'room' ? 'Tim' : 'Lobby', m.name, m.text, m.scope === 'room' ? '#7dffb0' : '#8fd8ff'));

  // Klik di luar input chat untuk menutup chat
  document.addEventListener('mousedown', e => {
    if (state.chatOpen && e.target !== input && e.target !== btn && !inputRow.contains(e.target)) {
      closeChat(false);
    }
  });

  // capture agar jalan sebelum handler game
  document.addEventListener('keydown', e => {
    if (state.mode === 'menu') return;
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (!state.chatOpen) { if (!e.repeat) openChat(); }
      else closeChat(true);
    } else if (e.key === 'Escape' && state.chatOpen) {
      closeChat(false);
    } else if (state.chatOpen) {
      e.stopPropagation();    // ketikan tidak boleh memicu kontrol game
    }
  }, true);
  document.addEventListener('keyup', e => { if (state.chatOpen) e.stopPropagation(); }, true);

  setInterval(fade, 1000);
}

export function setChatVisible(v, label) {
  if (!wrap) return;
  if (label) scopeLabel = label;
  wrap.style.display = v ? 'block' : 'none';
  if (btn) btn.style.display = v ? 'flex' : 'none';
  if (!v && state.chatOpen) closeChat(false);
}

export function clearChat() { if (log) log.innerHTML = ''; }

export function addSystem(text, color = '#ffd000') {
  addLine('', text, color, true);
}

function addMessage(scope, name, text, color) {
  addLine(scope, `${name}: ${text}`, color, false);
}

function addLine(scope, text, color, system) {
  if (!log) return;
  const row = document.createElement('div');
  row.style.cssText = 'background:rgba(0,0,0,0.45);padding:2px 8px;border-radius:4px;color:#fff;text-shadow:0 0 4px #000;word-break:break-word;transition:opacity .6s;';
  row.dataset.t = String(Date.now());
  if (!system) {
    const tag = document.createElement('span');
    tag.textContent = `[${scope}] `; tag.style.color = color;
    row.appendChild(tag);
    row.appendChild(document.createTextNode(text));      // textContent → aman dari XSS
  } else {
    row.style.color = color; row.style.fontStyle = 'italic';
    row.textContent = text;
  }
  log.appendChild(row);
  while (log.children.length > MAX_LINES) log.removeChild(log.firstChild);
}

function fade() {
  if (!log) return;
  const now = Date.now();
  for (const row of log.children) {
    const old = now - Number(row.dataset.t) > 12000;
    row.style.opacity = (old && !state.chatOpen) ? '0' : '1';
  }
}

function openChat() {
  if (state.chatOpen || state.teamOver) return;
  state.chatOpen = true;
  window.__clearKeys && window.__clearKeys();
  if (!isTouch) document.exitPointerLock();
  if (inputRow) inputRow.style.display = 'flex';
  input.value = '';
  setTimeout(() => input.focus(), 0);
  fade();
}

function closeChat(send) {
  if (!state.chatOpen) return;
  if (send) {
    const text = input.value.trim();
    if (text) net.sendChat(text);
  }
  state.chatOpen = false;
  if (inputRow) inputRow.style.display = 'none';
  input.blur(); input.value = '';
  if (!isTouch && chatLockPointer && state.mode !== 'menu' && !state.teamOver) {
    chatLockPointer();
    // browser kadang menolak re-lock (mis. sesudah Esc) → jangan biarkan pemain terjebak tanpa menu
    setTimeout(() => {
      if (!document.pointerLockElement && !state.chatOpen && state.mode !== 'menu' && !state.teamOver) showPause();
    }, 500);
  }
}
