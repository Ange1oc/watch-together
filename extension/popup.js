'use strict';

const DEFAULT_SERVER = 'wss://your-server.railway.app';
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const $ = id => document.getElementById(id);

const dot = $('dot');
const pillText = $('pill-text');
const panelNoSite = $('panel-no-site');
const panelMain = $('panel-main');
const panelDisconn = $('panel-disconnected');
const panelConn = $('panel-connected');
const srvUrlDisplay = $('srv-url-display');
const srvUrlInput = $('srv-url-input');
const srvUrlErr = $('srv-url-err');
const btnToggleSrv = $('btn-toggle-srv');
const srvEdit = $('srv-edit');
const btnSaveSrv = $('btn-save-srv');
const noVideoWarn = $('no-video-warn');
const usernameInput = $('username-input');
const roomInput = $('room-input');
const btnJoin = $('btn-join');
const btnCreate = $('btn-create');
const roomCode = $('room-code');
const btnCopy = $('btn-copy');
const usersWrap = $('users-wrap');
const speedWrap = $('speed-wrap');
const btnDisconnect = $('btn-disconnect');
const chatLog = $('chat-log');
const chatInput = $('chat-input');
const btnSendChat = $('btn-send-chat');
const chatBadge = $('chat-badge');

let myUsername = null;
let activeTab = 'tab-room';
let unreadChat = 0;

SPEEDS.forEach(s => {
    const b = document.createElement('button');
    b.className = 'spd-btn' + (s === 1 ? ' active' : '');
    b.textContent = s === 1 ? '1\xD7' : s + '\xD7';
    b.dataset.speed = String(s);
    b.addEventListener('click', () => {
        sendToContent({ type: 'SET_SPEED', speed: s });
        setSpeedActive(s);
    });
    speedWrap.appendChild(b);
});

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const id = btn.dataset.tab;
        activeTab = id;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $(id).classList.add('active');
        if (id === 'tab-chat') {
            unreadChat = 0;
            chatBadge.style.display = 'none';
            scrollChat();
        }
    });
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    const isWeb = tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'));
    if (!isWeb) {
        panelNoSite.style.display = 'block';
        return;
    }
    panelMain.style.display = 'block';

    chrome.storage.local.get(['serverUrl', 'username', 'lastRoom'], data => {
        const url = data.serverUrl || DEFAULT_SERVER;
        srvUrlInput.value = url;
        srvUrlDisplay.textContent = trimUrl(url);
        if (data.username) { usernameInput.value = data.username; myUsername = data.username; }
        if (data.lastRoom) roomInput.value = data.lastRoom;
    });

    chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, res => {
        if (chrome.runtime.lastError || !res) {
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
                .then(() => chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, res2 => {
                    if (!chrome.runtime.lastError && res2) applyFullStatus(res2, tab.id);
                }))
                .catch(() => { });
            return;
        }
        applyFullStatus(res, tab.id);
    });
});

function applyFullStatus(res, tabId) {
    applyState(res.state, res.room);
    if (res.serverUrl) {
        srvUrlInput.value = res.serverUrl;
        srvUrlDisplay.textContent = trimUrl(res.serverUrl);
    }
    if (res.username) myUsername = res.username;
    if (res.speed) setSpeedActive(res.speed);
    noVideoWarn.style.display = res.hasVideo ? 'none' : 'flex';

    chrome.tabs.sendMessage(tabId, { type: 'GET_USERS' }, r => {
        if (!chrome.runtime.lastError && r) renderUsers(r.users || []);
    });
    chrome.tabs.sendMessage(tabId, { type: 'GET_CHAT' }, r => {
        if (!chrome.runtime.lastError && r) renderChatLog(r.log || []);
    });
}

chrome.runtime.onMessage.addListener(msg => {
    switch (msg.type) {
        case 'STATUS_UPDATE':
            applyState(msg.state, msg.room);
            if (msg.username) myUsername = msg.username;
            if (msg.speed != null) setSpeedActive(msg.speed);
            if (msg.hasVideo != null) noVideoWarn.style.display = msg.hasVideo ? 'none' : 'flex';
            break;
        case 'USERS_UPDATE':
            renderUsers(msg.users || []);
            break;
        case 'CHAT_UPDATE':
            renderChatLog(msg.log || []);
            if (activeTab !== 'tab-chat') {
                unreadChat++;
                chatBadge.textContent = unreadChat > 9 ? '9+' : String(unreadChat);
                chatBadge.style.display = 'inline';
            }
            break;
        case 'NAVIGATE_UPDATE':
            renderNavInfo(msg.url, msg.title);
            break;
    }
});

btnToggleSrv.addEventListener('click', () => {
    const open = srvEdit.classList.toggle('open');
    btnToggleSrv.textContent = open ? '✕ Закрыть' : '✏️ Изменить';
});

btnSaveSrv.addEventListener('click', () => {
    let url = srvUrlInput.value.trim();
    if (!url) return;
    url = url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    if (!/^wss?:\/\/.+/.test(url)) {
        srvUrlErr.classList.add('show');
        return;
    }
    srvUrlErr.classList.remove('show');
    srvUrlInput.value = url;
    srvUrlDisplay.textContent = trimUrl(url);
    chrome.storage.local.set({ serverUrl: url });
    srvEdit.classList.remove('open');
    btnToggleSrv.textContent = '✏️ Изменить';
});

btnJoin.addEventListener('click', () => {
    const room = roomInput.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!room) {
        roomInput.classList.add('err');
        roomInput.addEventListener('input', () => roomInput.classList.remove('err'), { once: true });
        return;
    }
    doConnect(room);
});

btnCreate.addEventListener('click', () => {
    const room = genRoomId();
    roomInput.value = room;
    doConnect(room);
});

btnDisconnect.addEventListener('click', () => {
    sendToContent({ type: 'DISCONNECT' });
    applyState('disconnected', null);
});

btnCopy.addEventListener('click', () => {
    const id = roomCode.textContent;
    if (!id || id === '—') return;
    navigator.clipboard.writeText(id).then(() => {
        btnCopy.textContent = '✅';
        setTimeout(() => { btnCopy.textContent = '📋'; }, 2000);
    }).catch(() => { });
});

btnSendChat.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    sendToContent({ type: 'CHAT', message: text });
    chatInput.value = '';
    chatInput.focus();
}

function doConnect(room) {
    let url = srvUrlInput.value.trim() || DEFAULT_SERVER;
    url = url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    const username = usernameInput.value.trim() || ('User' + Math.floor(Math.random() * 9000 + 1000));
    myUsername = username;
    chrome.storage.local.set({ serverUrl: url, username, lastRoom: room });
    sendToContent({ type: 'CONNECT', serverUrl: url, room, username });
    applyState('connecting', room);
}

function applyState(state, room) {
    dot.className = 'dot ' + state;
    pillText.className = 'pill-text ' + state;
    const labels = { disconnected: 'Офлайн', connecting: 'Подключение…', connected: 'Онлайн' };
    pillText.textContent = labels[state] || '—';

    if (state === 'connected' && room) {
        panelDisconn.style.display = 'none';
        panelConn.style.display = 'block';
        roomCode.textContent = room;
    } else {
        panelDisconn.style.display = 'block';
        panelConn.style.display = 'none';
        activeTab = 'tab-room';
        document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
        document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('active', i === 0));
        unreadChat = 0;
        chatBadge.style.display = 'none';
    }
}

function renderUsers(users) {
    usersWrap.innerHTML = users.map(u => {
        const me = (u === myUsername);
        return '<div class="user-chip' + (me ? ' me' : '') + '">' +
            '<div class="user-dot"></div>' + esc(u) + (me ? ' (вы)' : '') + '</div>';
    }).join('');
}

function renderNavInfo(url, title) {
    const sect = $('nav-sect');
    const label = $('nav-title');
    const link = $('nav-goto');
    if (!url) { sect.style.display = 'none'; return; }
    const display = (title && title.length > 1) ? title : url;
    label.textContent = display.length > 60 ? display.slice(0, 58) + '\u2026' : display;
    link.href = url;
    sect.style.display = '';
}

function setSpeedActive(speed) {
    const rounded = SPEEDS.reduce((p, c) => Math.abs(c - speed) < Math.abs(p - speed) ? c : p);
    document.querySelectorAll('.spd-btn').forEach(b => {
        b.classList.toggle('active', parseFloat(b.dataset.speed) === rounded);
    });
}

function renderChatLog(log) {
    if (!log.length) {
        chatLog.innerHTML = '<div class="chat-empty">Чат пока пуст</div>';
        return;
    }
    const atBottom = chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 12;
    chatLog.innerHTML = log.map(m => {
        const mine = m.mine || m.username === myUsername;
        const nameHtml = !mine ? '<div class="chat-name">' + esc(m.username) + '</div>' : '';
        return '<div class="chat-msg ' + (mine ? 'mine' : 'theirs') + '">' +
            nameHtml + '<div class="chat-bubble">' + esc(m.message) + '</div></div>';
    }).join('');
    if (atBottom) scrollChat();
}

function scrollChat() {
    setTimeout(() => { chatLog.scrollTop = chatLog.scrollHeight; }, 30);
}

function sendToContent(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, msg, () => { void chrome.runtime.lastError; });
    });
}

function genRoomId() {
    const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function trimUrl(url) {
    return url.replace(/^wss?:\/\//, '').replace(/\/$/, '');
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
