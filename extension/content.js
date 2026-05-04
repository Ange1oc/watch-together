(function () {
    'use strict';

    if (window._vsync) return;
    window._vsync = true;

    if (window !== window.top) {
        let ifSyncing = false;
        let ifSyncTimer = null;

        function ifApplySync(fn) {
            ifSyncing = true;
            try { fn(); } catch { }
            if (ifSyncTimer) clearTimeout(ifSyncTimer);
            ifSyncTimer = setTimeout(() => { ifSyncing = false; }, 1000);
        }

        function getBestIframeVideo() {
            return [...document.querySelectorAll('video')]
                .filter(v => v.readyState > 0 || v.src || v.currentSrc)
                .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0] || null;
        }

        function setupIframeVideo(v) {
            if (v._vsync_if) return;
            v._vsync_if = true;

            v.addEventListener('play', () => {
                if (ifSyncing) return;
                window.parent.postMessage({ _vsync: true, type: 'play', time: v.currentTime }, '*');
            });
            v.addEventListener('pause', () => {
                if (ifSyncing) return;
                window.parent.postMessage({ _vsync: true, type: 'pause', time: v.currentTime }, '*');
            });
            let sdt = null;
            v.addEventListener('seeked', () => {
                if (ifSyncing) return;
                if (sdt) clearTimeout(sdt);
                sdt = setTimeout(() => {
                    if (!ifSyncing)
                        window.parent.postMessage({ _vsync: true, type: 'seek', time: v.currentTime }, '*');
                }, 150);
            });
            v.addEventListener('ratechange', () => {
                if (ifSyncing) return;
                window.parent.postMessage({ _vsync: true, type: 'speed', speed: v.playbackRate }, '*');
            });
        }

        window.addEventListener('message', e => {
            if (!e.data || e.data._vsync_src !== 'main') return;
            const d = e.data;
            const v = getBestIframeVideo();
            if (!v) return;
            ifApplySync(() => {
                if (d.type === 'play') { if (typeof d.time === 'number') v.currentTime = d.time; v.play().catch(() => { }); }
                else if (d.type === 'pause') { if (typeof d.time === 'number') v.currentTime = d.time; v.pause(); }
                else if (d.type === 'seek') { if (typeof d.time === 'number') v.currentTime = d.time; }
                else if (d.type === 'speed') { if (typeof d.speed === 'number' && d.speed > 0) v.playbackRate = d.speed; }
            });
        });

        function scanIframeVideos() { document.querySelectorAll('video').forEach(setupIframeVideo); }
        scanIframeVideos();
        new MutationObserver(scanIframeVideos).observe(document.documentElement, { childList: true, subtree: true });

        setInterval(() => {
            window.parent.postMessage({ _vsync: true, type: '_ifping', hasVideo: !!getBestIframeVideo() }, '*');
        }, 2000);

        return;
    }

    let ws = null;
    let wsState = 'disconnected';
    let currentRoom = null;
    let serverUrl = null;
    let myUsername = null;
    let userList = [];
    let isSyncing = false;
    let syncTimer = null;
    let reconnectTimer = null;
    let reconnectDelay = 4000;
    let pingInterval = null;
    let seekDebounceTimer = null;
    let notifyDebounceTimer = null;
    let navDebounceTimer = null;
    let lastBroadcastUrl = '';
    let iframeHasVideo = false;
    const chatLog = [];
    const MAX_CHAT = 100;

    const widget = buildWidget();
    function attachWidget() {
        if (document.body && !document.body.contains(widget))
            document.body.appendChild(widget);
    }
    attachWidget();
    new MutationObserver(attachWidget).observe(document.documentElement, { childList: true });

    chrome.runtime.onMessage.addListener((msg, _s, respond) => {
        switch (msg.type) {
            case 'CONNECT':
                serverUrl = msg.serverUrl;
                currentRoom = msg.room;
                myUsername = msg.username;
                reconnectDelay = 4000;
                connect();
                respond({ ok: true });
                break;

            case 'DISCONNECT':
                permanentDisconnect();
                respond({ ok: true });
                break;

            case 'GET_STATUS': {
                const v = getVideo();
                respond({ state: wsState, room: currentRoom, serverUrl, username: myUsername, speed: v ? v.playbackRate : 1, hasVideo: !!v || iframeHasVideo });
                break;
            }

            case 'GET_USERS':
                respond({ users: userList });
                break;

            case 'GET_CHAT':
                respond({ log: chatLog });
                break;

            case 'GET_NAV':
                respond({ url: location.href, title: document.title });
                break;

            case 'CHAT': {
                const text = String(msg.message || '').trim();
                if (text && ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'chat', message: text }));
                    addChat(myUsername, text, true);
                }
                respond({ ok: true });
                break;
            }

            case 'SET_SPEED': {
                const v = getVideo();
                const spd = Number(msg.speed);
                if (spd > 0 && spd <= 16) {
                    if (v) applySync(() => { v.playbackRate = spd; });
                    relayToIframes({ type: 'speed', speed: spd });
                    if (ws && ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify({ type: 'speed', speed: spd }));
                }
                respond({ ok: true });
                break;
            }
        }
        return true;
    });

    function connect() {
        if (ws) { ws.onclose = null; ws.close(); ws = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }

        wsState = 'connecting';
        notifyPopup(); updateWidget();

        const wsUrl = serverUrl.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws');
        try { ws = new WebSocket(wsUrl); }
        catch {
            wsState = 'disconnected';
            notifyPopup(); updateWidget();
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            wsState = 'connected';
            reconnectDelay = 4000;
            notifyPopup(); updateWidget();
            ws.send(JSON.stringify({
                type: 'join', room: currentRoom, username: myUsername,
                url: location.href, title: document.title,
            }));
            pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ type: 'ping' }));
            }, 25000);
        };

        ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch { } };

        ws.onclose = () => {
            wsState = 'disconnected';
            if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
            notifyPopup(); updateWidget();
            if (currentRoom && serverUrl) scheduleReconnect();
        };

        ws.onerror = () => { };
    }

    function permanentDisconnect() {
        currentRoom = null; serverUrl = null; reconnectDelay = 4000;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (ws) { ws.onclose = null; ws.close(); ws = null; }
        wsState = 'disconnected'; userList = [];
        notifyPopup(); updateWidget();
    }

    function scheduleReconnect() {
        reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), 30000);
            connect();
        }, reconnectDelay);
    }

    function handleMessage(data) {
        switch (data.type) {

            case 'room_joined': {
                userList = data.users || [];
                notifyPopup(); updateWidget();
                const v = getVideo();
                if (typeof data.currentTime === 'number' && data.currentTime > 2) {
                    if (v) {
                        applySync(() => {
                            v.currentTime = data.currentTime;
                            if (typeof data.speed === 'number' && data.speed > 0)
                                v.playbackRate = data.speed;
                            if (data.playing) v.play().catch(() => { });
                            else v.pause();
                        });
                    }
                    relayToIframes({ type: data.playing ? 'play' : 'pause', time: data.currentTime });
                    if (typeof data.speed === 'number' && data.speed > 0)
                        relayToIframes({ type: 'speed', speed: data.speed });
                }
                if (data.url && data.url !== location.href) {
                    showNavSuggestion('\u043a\u043e\u043c\u043d\u0430\u0442\u0430', data.url, data.title || data.url);
                }
                chrome.runtime.sendMessage({
                    type: 'NAVIGATE_UPDATE',
                    url: data.url || '',
                    title: data.title || '',
                    username: '',
                }).catch(() => { });
                break;
            }

            case 'user_joined':
                userList = data.users || [];
                notifyPopup(); updateWidget();
                if (data.username !== myUsername)
                    toast('\uD83D\uDC64 ' + data.username + ' \u043F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u043B\u0441\u044F');
                break;

            case 'user_left':
                userList = data.users || [];
                notifyPopup(); updateWidget();
                toast('\uD83D\uDC64 ' + data.username + ' \u043F\u043E\u043A\u0438\u043D\u0443\u043B \u043A\u043E\u043C\u043D\u0430\u0442\u0443');
                break;

            case 'play': {
                const v = getVideo();
                if (v) applySync(() => { v.currentTime = data.time; v.play().catch(() => { }); });
                relayToIframes({ type: 'play', time: data.time });
                toast('\u25B6 ' + data.username + ' \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u0435');
                break;
            }

            case 'pause': {
                const v = getVideo();
                if (v) applySync(() => { v.currentTime = data.time; v.pause(); });
                relayToIframes({ type: 'pause', time: data.time });
                toast('\u23F8 ' + data.username + ' \u043F\u0430\u0443\u0437\u0430');
                break;
            }

            case 'seek': {
                const v = getVideo();
                if (v) applySync(() => { v.currentTime = data.time; });
                relayToIframes({ type: 'seek', time: data.time });
                toast('\u23E9 ' + data.username + ' \u043F\u0435\u0440\u0435\u043C\u043E\u0442\u0430\u043B');
                break;
            }

            case 'speed': {
                const v = getVideo();
                const spd = Number(data.speed);
                if (v && spd > 0) applySync(() => { v.playbackRate = spd; });
                relayToIframes({ type: 'speed', speed: spd });
                notifyPopup(); updateWidget();
                toast('\u26A1 ' + data.username + ' \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C: ' + spd + '\xD7');
                break;
            }

            case 'chat':
                addChat(data.username, data.message, false);
                toast('\uD83D\uDCAC ' + data.username + ': ' + data.message);
                break;

            case 'navigate': {
                const navUrl = String(data.url || '');
                const navTitle = String(data.title || navUrl);
                if (navUrl && navUrl !== location.href) {
                    showNavSuggestion(data.username, navUrl, navTitle);
                }
                chrome.runtime.sendMessage({
                    type: 'NAVIGATE_UPDATE', url: navUrl, title: navTitle, username: data.username,
                }).catch(() => { });
                break;
            }

            case 'pong': break;
        }
    }

    function addChat(username, message, mine) {
        chatLog.push({ username, message, ts: Date.now(), mine });
        if (chatLog.length > MAX_CHAT) chatLog.shift();
        chrome.runtime.sendMessage({ type: 'CHAT_UPDATE', log: chatLog }).catch(() => { });
    }

    function getVideo() {
        const all = [...document.querySelectorAll('video')];
        if (!all.length) return null;
        const visible = all.filter(v => {
            const r = v.getBoundingClientRect();
            return r.width > 80 && r.height > 45;
        });
        const pool = visible.length ? visible : all;
        return pool.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
        })[0];
    }

    function setupVideo(v) {
        if (v._vsync) return;
        v._vsync = true;

        v.addEventListener('play', () => {
            if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ type: 'play', time: v.currentTime }));
        });

        v.addEventListener('pause', () => {
            if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ type: 'pause', time: v.currentTime }));
        });

        v.addEventListener('seeked', () => {
            if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
            if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
            seekDebounceTimer = setTimeout(() => {
                if (!isSyncing && ws && ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ type: 'seek', time: v.currentTime }));
            }, 150);
        });

        v.addEventListener('ratechange', () => {
            if (isSyncing || !ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ type: 'speed', speed: v.playbackRate }));
            notifyPopup(); updateWidget();
        });
    }

    function findAndSetup() {
        document.querySelectorAll('video').forEach(setupVideo);
    }
    findAndSetup();
    new MutationObserver(findAndSetup).observe(document.documentElement, { childList: true, subtree: true });

    function broadcastNavigate() {
        const url = location.href;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (url === lastBroadcastUrl) return;
        lastBroadcastUrl = url;
        ws.send(JSON.stringify({ type: 'navigate', url, title: document.title }));
        chrome.runtime.sendMessage({ type: 'NAVIGATE_UPDATE', url, title: document.title, username: myUsername }).catch(() => { });
    }

    function scheduleNavBroadcast() {
        if (navDebounceTimer) clearTimeout(navDebounceTimer);
        navDebounceTimer = setTimeout(broadcastNavigate, 800);
    }

    (function patchHistory() {
        ['pushState', 'replaceState'].forEach(method => {
            const orig = history[method];
            history[method] = function (...args) {
                const r = orig.apply(this, args);
                scheduleNavBroadcast();
                return r;
            };
        });
    })();

    window.addEventListener('popstate', scheduleNavBroadcast);
    window.addEventListener('hashchange', scheduleNavBroadcast);

    function relayToIframes(cmd) {
        document.querySelectorAll('iframe').forEach(iframe => {
            try { iframe.contentWindow.postMessage({ _vsync_src: 'main', ...cmd }, '*'); } catch { }
        });
    }

    window.addEventListener('message', e => {
        if (!e.data || !e.data._vsync || e.source === window) return;
        const d = e.data;

        if (d.type === '_ifping') {
            iframeHasVideo = !!d.hasVideo;
            return;
        }

        if (!ws || ws.readyState !== WebSocket.OPEN || isSyncing) return;
        if (d.type === 'play')
            ws.send(JSON.stringify({ type: 'play', time: d.time }));
        else if (d.type === 'pause')
            ws.send(JSON.stringify({ type: 'pause', time: d.time }));
        else if (d.type === 'seek')
            ws.send(JSON.stringify({ type: 'seek', time: d.time }));
        else if (d.type === 'speed') {
            ws.send(JSON.stringify({ type: 'speed', speed: d.speed }));
            notifyPopup(); updateWidget();
        }
    });

    function applySync(fn) {
        if (syncTimer) clearTimeout(syncTimer);
        isSyncing = true;
        try { fn(); } catch { }
        syncTimer = setTimeout(() => { isSyncing = false; }, 1000);
    }

    function notifyPopup() {
        if (notifyDebounceTimer) clearTimeout(notifyDebounceTimer);
        notifyDebounceTimer = setTimeout(() => {
            const v = getVideo();
            chrome.runtime.sendMessage({
                type: 'STATUS_UPDATE', state: wsState, room: currentRoom,
                serverUrl, username: myUsername, speed: v ? v.playbackRate : 1, hasVideo: !!v || iframeHasVideo,
            }).catch(() => { });
            chrome.runtime.sendMessage({ type: 'USERS_UPDATE', users: userList }).catch(() => { });
        }, 50);
    }

    function buildWidget() {
        const el = document.createElement('div');
        el.id = 'vsync-widget';
        el.style.cssText = [
            'position:fixed', 'top:72px', 'right:16px', 'z-index:2147483647',
            'background:rgba(13,13,24,0.96)', 'color:#dde1ea',
            'font:13px/1.5 "Segoe UI",Arial,sans-serif', 'border-radius:10px',
            'padding:6px 14px', 'display:none', 'align-items:center', 'gap:9px',
            'box-shadow:0 4px 24px rgba(0,0,0,.8)', 'pointer-events:none',
            'border:1px solid rgba(233,69,96,.3)', 'backdrop-filter:blur(6px)',
        ].join(';');
        return el;
    }

    function updateWidget() {
        ensureStyles();
        if (wsState === 'connected' && currentRoom) {
            const v = getVideo();
            const spd = v ? v.playbackRate : 1;
            const spdPart = spd !== 1 ? ' \xB7 <span style="color:#e94560">' + spd + '\xD7</span>' : '';
            widget.style.display = 'flex';
            widget.innerHTML =
                '<span style="width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80;flex-shrink:0;display:inline-block"></span>' +
                '<span><b style="color:#e94560">' + escHtml(currentRoom) + '</b> \xB7 ' + userList.length + ' \uD83D\uDC64' + spdPart + '</span>';
        } else if (wsState === 'connecting') {
            widget.style.display = 'flex';
            widget.innerHTML =
                '<span style="width:8px;height:8px;border-radius:50%;background:#fb923c;flex-shrink:0;display:inline-block;animation:vsync-pulse 1s infinite"></span>' +
                '<span style="color:#999">\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435\u2026</span>';
        } else {
            widget.style.display = 'none';
        }
    }

    function ensureStyles() {
        if (document.getElementById('vsync-styles')) return;
        const s = document.createElement('style');
        s.id = 'vsync-styles';
        s.textContent = '@keyframes vsync-pulse{0%,100%{opacity:1}50%{opacity:.2}}';
        (document.head || document.documentElement).appendChild(s);
    }

    const toastQ = [];
    let toastBusy = false;

    function toast(text) {
        toastQ.push(text);
        if (!toastBusy) nextToast();
    }

    function nextToast() {
        if (!toastQ.length) { toastBusy = false; return; }
        toastBusy = true;
        const text = toastQ.shift();
        let el = document.getElementById('vsync-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'vsync-toast';
            el.style.cssText = [
                'position:fixed', 'bottom:80px', 'right:16px',
                'background:rgba(13,13,24,0.96)', 'color:#dde1ea',
                'padding:8px 14px', 'border-radius:10px',
                'font:12px/1.5 "Segoe UI",Arial,sans-serif',
                'z-index:2147483646', 'pointer-events:none',
                'transition:opacity .25s, transform .25s',
                'max-width:280px', 'word-break:break-word',
                'box-shadow:0 4px 16px rgba(0,0,0,.7)',
                'border:1px solid rgba(255,255,255,.08)',
            ].join(';');
            (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = text;
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(6px)';
            setTimeout(nextToast, 280);
        }, 2500);
    }

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escAttr(s) {
        return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function showNavSuggestion(fromUser, url, title) {
        const old = document.getElementById('vsync-nav-banner');
        if (old) old.remove();
        ensureStyles();

        const banner = document.createElement('div');
        banner.id = 'vsync-nav-banner';
        banner.style.cssText = [
            'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
            'z-index:2147483647', 'max-width:400px', 'width:calc(100% - 32px)',
            'background:rgba(13,13,24,0.97)', 'color:#dde1ea',
            'border:1px solid rgba(233,69,96,.5)', 'border-radius:12px',
            'padding:10px 14px', 'box-shadow:0 6px 32px rgba(0,0,0,.9)',
            'font:13px/1.5 "Segoe UI",Arial,sans-serif',
            'display:flex', 'align-items:center', 'gap:10px',
        ].join(';');

        const shortTitle = (title || url).length > 55
            ? (title || url).slice(0, 52) + '\u2026'
            : (title || url);

        banner.innerHTML =
            '<span style="font-size:20px;flex-shrink:0">\uD83C\uDFAC</span>' +
            '<div style="flex:1;min-width:0">' +
            '<div style="font-size:11px;color:#888;margin-bottom:1px">' +
            escHtml(fromUser) + ' \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438\u0442 \u043A \u043D\u043E\u0432\u043E\u0439 \u0441\u0435\u0440\u0438\u0438</div>' +
            '<div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
            escHtml(shortTitle) + '</div>' +
            '</div>' +
            '<a href="' + escAttr(url) + '" style="flex-shrink:0;background:#e94560;color:#fff;' +
            'text-decoration:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;">\u041F\u0435\u0440\u0435\u0439\u0442\u0438</a>' +
            '<button id="vsync-nav-close" style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;padding:0 2px;flex-shrink:0;line-height:1">&times;</button>';

        (document.body || document.documentElement).appendChild(banner);
        document.getElementById('vsync-nav-close').addEventListener('click', () => banner.remove());
        setTimeout(() => { if (banner.isConnected) banner.remove(); }, 15000);
    }

})();
