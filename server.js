const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

app.use(cors());
app.use(express.json());

// rooms: Map<roomId, Set<{ ws, username }>>
const rooms = new Map();
// roomStates: Map<roomId, { time, playing, speed, url, title, updatedAt }>
const roomStates = new Map();

// ─── HTTP endpoints ────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    totalUsers: [...rooms.values()].reduce((sum, r) => sum + r.size, 0),
  });
});

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

// ─── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let currentRoom = null;
  let username = 'Anonymous';

  // Simple per-connection rate limiter (max 30 events/sec)
  let msgCount = 0;
  const rateLimitReset = setInterval(() => { msgCount = 0; }, 1000);
  const MAX_MSG_PER_SEC = 30;

  ws.on('message', (rawData) => {
    msgCount++;
    if (msgCount > MAX_MSG_PER_SEC) return; // drop burst

    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      return;
    }

    switch (data.type) {

      case 'join': {
        const roomId = String(data.room || '').trim().slice(0, 64);
        if (!roomId) return;

        username = String(data.username || 'Anonymous').trim().slice(0, 32);

        // Store url/title from the joiner (first joiner initialises the room URL)
        const joinUrl = String(data.url || '').slice(0, 2048);
        const joinTitle = String(data.title || '').slice(0, 256);

        // Leave old room
        if (currentRoom) leaveRoom(ws, currentRoom);

        // Join new room
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        currentRoom = roomId;
        rooms.get(roomId).add({ ws, username });

        // Send current room state to newcomer
        const state = roomStates.get(roomId);
        let currentTime = 0;
        let playing = false;
        let speed = 1;
        let roomUrl = joinUrl;
        let roomTitle = joinTitle;
        if (state) {
          currentTime = state.playing
            ? state.time + (Date.now() - state.updatedAt) / 1000
            : state.time;
          playing = state.playing;
          speed = state.speed || 1;
          if (state.url) { roomUrl = state.url; roomTitle = state.title || ''; }
        } else {
          // First person to join — seed the room state with their URL
          roomStates.set(roomId, { time: 0, playing: false, speed: 1, url: joinUrl, title: joinTitle, updatedAt: Date.now() });
        }

        ws.send(JSON.stringify({
          type: 'room_joined',
          room: roomId,
          users: getRoomUsers(roomId),
          currentTime,
          playing,
          speed,
          url: roomUrl,
          title: roomTitle,
        }));

        // Notify others
        broadcastToRoom(roomId, {
          type: 'user_joined',
          username,
          users: getRoomUsers(roomId),
        }, ws);

        console.log(`[${roomId}] ${username} joined (${rooms.get(roomId).size} in room)`);
        break;
      }

      case 'navigate': {
        if (!currentRoom) return;
        const navUrl = String(data.url || '').slice(0, 2048);
        const navTitle = String(data.title || '').slice(0, 256);
        if (!navUrl) return;
        const prevStateNav = roomStates.get(currentRoom) || {};
        roomStates.set(currentRoom, { ...prevStateNav, url: navUrl, title: navTitle, time: 0, playing: false });
        broadcastToRoom(currentRoom, { type: 'navigate', url: navUrl, title: navTitle, username }, ws);
        break;
      }

      case 'play': {
        if (!currentRoom) return;
        const time = Number(data.time) || 0;
        const prevStatePl = roomStates.get(currentRoom) || {};
        roomStates.set(currentRoom, { time, playing: true, speed: prevStatePl.speed || 1, updatedAt: Date.now() });
        broadcastToRoom(currentRoom, { type: 'play', time, username }, ws);
        break;
      }

      case 'pause': {
        if (!currentRoom) return;
        const time = Number(data.time) || 0;
        const prevStatePa = roomStates.get(currentRoom) || {};
        roomStates.set(currentRoom, { time, playing: false, speed: prevStatePa.speed || 1, updatedAt: Date.now() });
        broadcastToRoom(currentRoom, { type: 'pause', time, username }, ws);
        break;
      }

      case 'seek': {
        if (!currentRoom) return;
        const time = Number(data.time) || 0;
        const prevStateSk = roomStates.get(currentRoom);
        roomStates.set(currentRoom, {
          time,
          playing: prevStateSk ? prevStateSk.playing : false,
          speed: prevStateSk ? prevStateSk.speed || 1 : 1,
          updatedAt: Date.now(),
        });
        broadcastToRoom(currentRoom, { type: 'seek', time, username }, ws);
        break;
      }

      case 'speed': {
        if (!currentRoom) return;
        const speed = Number(data.speed);
        if (!speed || speed <= 0 || speed > 16) return;
        const prevStateSp = roomStates.get(currentRoom) || {};
        roomStates.set(currentRoom, {
          time: prevStateSp.time || 0,
          playing: prevStateSp.playing || false,
          speed,
          updatedAt: Date.now(),
        });
        broadcastToRoom(currentRoom, { type: 'speed', speed, username }, ws);
        break;
      }

      case 'chat': {
        if (!currentRoom) return;
        const message = String(data.message || '').trim().slice(0, 500);
        if (!message) return;
        // Exclude sender — they already added the message to their local log
        broadcastToRoom(currentRoom, {
          type: 'chat',
          message,
          username,
        }, ws);
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(rateLimitReset);
    if (currentRoom) leaveRoom(ws, currentRoom);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function leaveRoom(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const peer = [...room].find((p) => p.ws === ws);
  if (!peer) return;

  room.delete(peer);
  console.log(`[${roomId}] ${peer.username} left (${room.size} remain)`);

  if (room.size === 0) {
    rooms.delete(roomId);
    roomStates.delete(roomId);
  } else {
    broadcastToRoom(roomId, {
      type: 'user_left',
      username: peer.username,
      users: getRoomUsers(roomId),
    }, null);
  }
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room].map((p) => p.username);
}

function broadcastToRoom(roomId, message, excludeWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  const json = JSON.stringify(message);
  room.forEach(({ ws }) => {
    if (ws !== excludeWs && ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rezka Sync server running on port ${PORT}`);
});
