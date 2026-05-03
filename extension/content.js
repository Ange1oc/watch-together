/* ============================================================
   Rezka Sync — Content Script
   Runs on rezka-ua.tv, manages WebSocket + video sync logic
   ============================================================ */
(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────────

  let ws = null;
  let wsState = 'disconnected'; // disconnected | connecting | connected
  let currentRoom = null;
  let serverUrl = null;
  let myUsername = null;
  let userList = [];
  let isSyncing = false;      // true while applying a remote event (prevents echo)
  let reconnectTimer = null;
  let pingInterval = null;

  // ─── Overlay widget (shown while connected) ───────────────────────────────────

  const widget = createWidget();
  document.body.appendChild(widget);

  // ─── Message listener from popup ─────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'CONNECT':
        serverUrl  = msg.serverUrl;
        currentRoom = msg.room;
        myUsername  = msg.username;
        connect();
        sendResponse({ success: true });
        break;

      case 'DISCONNECT':
        permanentDisconnect();
        sendResponse({ success: true });
        break;

      case 'GET_STATUS':
        sendResponse({ state: wsState, room: currentRoom, serverUrl });
        break;

      case 'GET_USERS':
        sendResponse({ users: userList });
        break;

      case 'CHAT':
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'chat', message: msg.message }));
        }
        sendResponse({ success: true });
        break;
    }
    return true; // keep channel open for async sendResponse
  });

  // ─── WebSocket ────────────────────────────────────────────────────────────────

  function connect() {
    if (ws) {
      ws.onclose = null; // prevent auto-reconnect from old instance
      ws.close();
      ws = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingInterval)   { clearInterval(pingInterval);  pingInterval   = null; }

    wsState = 'connecting';
    notifyPopup();
    updateWidget();

    // Normalise URL: http(s) → ws(s)
    const wsUrl = serverUrl.replace(/^http/, 'ws');

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      wsState = 'disconnected';
      notifyPopup();
      updateWidget();
      return;
    }

    ws.onopen = () => {
      wsState = 'connected';
      notifyPopup();
      updateWidget();

      ws.send(JSON.stringify({ type: 'join', room: currentRoom, username: myUsername }));

      // Keep-alive ping every 25 s (helps on Render free tier)
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      wsState = 'disconnected';
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      notifyPopup();
      updateWidget();

      // Auto-reconnect only if we still have a room configured
      if (currentRoom && serverUrl) {
        reconnectTimer = setTimeout(connect, 4000);
      }
    };

    ws.onerror = () => {
      wsState = 'disconnected';
      notifyPopup();
      updateWidget();
    };
  }

  function permanentDisconnect() {
    currentRoom = null;
    serverUrl   = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingInterval)   { clearInterval(pingInterval);  pingInterval   = null; }
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    wsState  = 'disconnected';
    userList = [];
    notifyPopup();
    updateWidget();
  }

  // ─── Handle messages from server ─────────────────────────────────────────────

  function handleServerMessage(data) {
    switch (data.type) {

      case 'room_joined': {
        userList = data.users || [];
        notifyPopup();
        updateWidget();

        // Sync to current room position when joining
        const video = getVideo();
        if (video && typeof data.currentTime === 'number' && data.currentTime > 2) {
          applySync(() => {
            video.currentTime = data.currentTime;
            if (data.playing) {
              video.play().catch(() => {});
            } else {
              video.pause();
            }
          });
        }
        break;
      }

      case 'user_joined':
        userList = data.users || [];
        notifyPopup();
        updateWidget();
        if (data.username !== myUsername) {
          showToast(`👤 ${data.username} присоединился`);
        }
        break;

      case 'user_left':
        userList = data.users || [];
        notifyPopup();
        updateWidget();
        showToast(`👤 ${data.username} покинул комнату`);
        break;

      case 'play': {
        const video = getVideo();
        if (video) {
          applySync(() => {
            video.currentTime = data.time;
            video.play().catch(() => {});
          });
        }
        showToast(`▶ ${data.username} нажал воспроизведение`);
        break;
      }

      case 'pause': {
        const video = getVideo();
        if (video) {
          applySync(() => {
            video.currentTime = data.time;
            video.pause();
          });
        }
        showToast(`⏸ ${data.username} поставил на паузу`);
        break;
      }

      case 'seek': {
        const video = getVideo();
        if (video) {
          applySync(() => {
            video.currentTime = data.time;
          });
        }
        showToast(`⏩ ${data.username} перемотал`);
        break;
      }

      case 'chat':
        showToast(`💬 ${data.username}: ${data.message}`);
        break;

      case 'pong':
        break;
    }
  }

  // ─── Video listeners ──────────────────────────────────────────────────────────

  function getVideo() {
    return document.querySelector('video');
  }

  function setupVideoListeners(video) {
    if (video._rzsync) return;
    video._rzsync = true;

    video.addEventListener('play', () => {
      if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'play', time: video.currentTime }));
    });

    video.addEventListener('pause', () => {
      if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'pause', time: video.currentTime }));
    });

    video.addEventListener('seeked', () => {
      if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'seek', time: video.currentTime }));
    });
  }

  // Watch for video element (player may load after page)
  function findAndSetup() {
    const video = getVideo();
    if (video) setupVideoListeners(video);
  }

  findAndSetup();
  new MutationObserver(findAndSetup)
    .observe(document.documentElement, { childList: true, subtree: true });

  // ─── Sync helper ─────────────────────────────────────────────────────────────

  function applySync(fn) {
    isSyncing = true;
    try { fn(); } catch { /* ignore */ }
    setTimeout(() => { isSyncing = false; }, 600);
  }

  // ─── Popup communication ──────────────────────────────────────────────────────

  function notifyPopup() {
    chrome.runtime.sendMessage({
      type:     'STATUS_UPDATE',
      state:    wsState,
      room:     currentRoom,
      serverUrl,
    }).catch(() => {});

    chrome.runtime.sendMessage({
      type:  'USERS_UPDATE',
      users: userList,
    }).catch(() => {});
  }

  // ─── Floating widget ──────────────────────────────────────────────────────────

  function createWidget() {
    const el = document.createElement('div');
    el.id = 'rzsynс-widget';
    el.style.cssText = [
      'position:fixed',
      'top:70px',
      'right:16px',
      'z-index:2147483647',
      'background:rgba(20,20,35,0.92)',
      'color:#e0e0e0',
      'font:13px/1.4 "Segoe UI",Arial,sans-serif',
      'border-radius:8px',
      'padding:6px 12px',
      'display:none',
      'align-items:center',
      'gap:8px',
      'box-shadow:0 2px 12px rgba(0,0,0,0.6)',
      'pointer-events:none',
      'border:1px solid rgba(233,69,96,0.4)',
    ].join(';');
    return el;
  }

  function updateWidget() {
    if (wsState === 'connected' && currentRoom) {
      const count = userList.length;
      widget.style.display = 'flex';
      widget.innerHTML =
        `<span style="width:8px;height:8px;border-radius:50%;background:#e94560;flex-shrink:0;display:inline-block"></span>` +
        `<span>SYNC &nbsp;|&nbsp; <b>${escHtml(currentRoom)}</b> &nbsp;|&nbsp; ${count} 👤</span>`;
    } else if (wsState === 'connecting') {
      widget.style.display = 'flex';
      widget.innerHTML =
        `<span style="width:8px;height:8px;border-radius:50%;background:#ff9800;flex-shrink:0;display:inline-block;animation:rzsync-pulse 1s infinite"></span>` +
        `<span>Подключение…</span>`;
      ensurePulseAnim();
    } else {
      widget.style.display = 'none';
    }
  }

  function ensurePulseAnim() {
    if (document.getElementById('rzsync-style')) return;
    const s = document.createElement('style');
    s.id = 'rzsync-style';
    s.textContent = '@keyframes rzsync-pulse{0%,100%{opacity:1}50%{opacity:.3}}';
    document.head.appendChild(s);
  }

  // ─── Toast notifications ──────────────────────────────────────────────────────

  let toastTimer = null;

  function showToast(text) {
    let toast = document.getElementById('rzsync-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rzsync-toast';
      toast.style.cssText = [
        'position:fixed',
        'bottom:90px',
        'left:50%',
        'transform:translateX(-50%)',
        'background:rgba(0,0,0,0.82)',
        'color:#fff',
        'padding:8px 20px',
        'border-radius:20px',
        'font:14px/1.4 "Segoe UI",Arial,sans-serif',
        'z-index:2147483647',
        'pointer-events:none',
        'transition:opacity .3s',
        'max-width:80vw',
        'text-align:center',
      ].join(';');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 3000);
  }

  // ─── Util ─────────────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

})();
