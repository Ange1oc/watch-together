/* ============================================================
   Rezka Sync — Popup script
   ============================================================ */
'use strict';

const DEFAULT_SERVER = 'wss://your-server.railway.app';

// ─── Element refs ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const statusDot       = $('status-dot');
const statusLabel     = $('status-label');
const panelNoSite     = $('panel-no-site');
const panelMain       = $('panel-main');
const panelDisconn    = $('panel-disconnected');
const panelConn       = $('panel-connected');

const toggleServerBtn = $('toggle-server');
const serverPanel     = $('server-panel');
const serverUrlInput  = $('server-url');
const serverUrlDisp   = $('server-url-display');
const btnSaveServer   = $('btn-save-server');

const usernameInput   = $('username');
const roomInput       = $('room-input');
const btnJoin         = $('btn-join');
const btnCreate       = $('btn-create');

const currentRoomId   = $('current-room-id');
const btnCopy         = $('btn-copy');
const usersList       = $('users-list');
const chatInput       = $('chat-input');
const btnSendChat     = $('btn-send-chat');
const btnDisconnect   = $('btn-disconnect');

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;

  const onRezka = tab.url && (
    tab.url.startsWith('https://rezka-ua.tv') ||
    tab.url.includes('.rezka-ua.tv')
  );

  if (!onRezka) {
    panelNoSite.style.display = 'block';
    panelMain.style.display   = 'none';
    return;
  }

  panelNoSite.style.display = 'none';
  panelMain.style.display   = 'block';

  // Load saved settings
  chrome.storage.local.get(['serverUrl', 'username'], (data) => {
    const url = data.serverUrl || DEFAULT_SERVER;
    serverUrlInput.value = url;
    serverUrlDisp.textContent = url;
    if (data.username) usernameInput.value = data.username;
  });

  // Query current state from content script
  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    applyState(res.state, res.room);
    if (res.serverUrl) {
      serverUrlInput.value = res.serverUrl;
      serverUrlDisp.textContent = res.serverUrl;
    }
  });

  chrome.tabs.sendMessage(tab.id, { type: 'GET_USERS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    renderUsers(res.users || []);
  });
});

// ─── Real-time updates from content script ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') applyState(msg.state, msg.room);
  if (msg.type === 'USERS_UPDATE')  renderUsers(msg.users || []);
});

// ─── Server settings ──────────────────────────────────────────────────────────

toggleServerBtn.addEventListener('click', () => {
  const open = serverPanel.classList.toggle('open');
  toggleServerBtn.textContent = open ? 'скрыть ▾' : 'изменить ▸';
});

btnSaveServer.addEventListener('click', () => {
  const url = serverUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ serverUrl: url });
  serverUrlDisp.textContent = url;
  serverPanel.classList.remove('open');
  toggleServerBtn.textContent = 'изменить ▸';
});

// ─── Join / Create ────────────────────────────────────────────────────────────

btnJoin.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) { roomInput.focus(); return; }
  doConnect(room);
});

btnCreate.addEventListener('click', () => {
  const room = genRoomId();
  roomInput.value = room;
  doConnect(room);
});

// ─── Disconnect ───────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', () => {
  sendToContent({ type: 'DISCONNECT' });
  applyState('disconnected', null);
});

// ─── Copy room ID ─────────────────────────────────────────────────────────────

btnCopy.addEventListener('click', () => {
  const id = currentRoomId.textContent;
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => {
    btnCopy.textContent = '✓';
    setTimeout(() => { btnCopy.textContent = '📋'; }, 2000);
  });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────

btnSendChat.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  sendToContent({ type: 'CHAT', message: msg });
  chatInput.value = '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function doConnect(room) {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER;
  const username  = usernameInput.value.trim() || ('User' + Math.floor(Math.random() * 9000 + 1000));

  chrome.storage.local.set({ serverUrl, username });

  sendToContent({
    type: 'CONNECT',
    serverUrl,
    room,
    username,
  });

  applyState('connecting', room);
}

function applyState(state, room) {
  // Status dot + label
  statusDot.className = 'status-dot ' + state;
  statusLabel.className = 'status-label ' + state;
  const labels = { disconnected: 'Отключён', connecting: 'Подключение…', connected: 'Подключён' };
  statusLabel.textContent = labels[state] || '—';

  if (state === 'connected' && room) {
    panelDisconn.style.display  = 'none';
    panelConn.style.display     = 'block';
    currentRoomId.textContent   = room;
  } else {
    panelDisconn.style.display  = 'block';
    panelConn.style.display     = 'none';
  }
}

function renderUsers(users) {
  usersList.innerHTML = users
    .map((u) => `<div class="user-item"><div class="user-dot"></div>${esc(u)}</div>`)
    .join('');
}

function sendToContent(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, msg, () => {
      if (chrome.runtime.lastError) {
        /* content script not ready — ignore */
      }
    });
  });
}

function genRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
