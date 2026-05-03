const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// rooms: Map<roomId, Set<{ ws, username }>>
const rooms = new Map();
// roomStates: Map<roomId, { time, playing, updatedAt }>
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

  ws.on('message', (rawData) => {
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
        if (state) {
          currentTime = state.playing
            ? state.time + (Date.now() - state.updatedAt) / 1000
            : state.time;
          playing = state.playing;
        }

        ws.send(JSON.stringify({
          type: 'room_joined',
          room: roomId,
          users: getRoomUsers(roomId),
          currentTime,
          playing,
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

      case 'play': {
        if (!currentRoom) return;
        const time = Number(data.time) || 0;
        roomStates.set(currentRoom, { time, playing: true, updatedAt: Date.now() });
        broadcastToRoom(currentRoom, {
          type: 'play',
          time,
          username,
        }, ws);
        break;
      }

      case 'pause': {
        if (!currentRoom) return;
        const time = Number(data.time) || 0;
        roomStates.set(currentRoom, { time, playing: false, updatedAt: Date.now() });
        broadcastToRoom(currentRoom, {
          type: 'pause',
          time,
          username,
        }, ws);
        break;
      }

      case 'seek': {
        if (!currentRoom) return;
        const time = Number(data.time) || 0;
        const prevState = roomStates.get(currentRoom);
        roomStates.set(currentRoom, {
          time,
          playing: prevState ? prevState.playing : false,
          updatedAt: Date.now(),
        });
        broadcastToRoom(currentRoom, {
          type: 'seek',
          time,
          username,
        }, ws);
        break;
      }

      case 'chat': {
        if (!currentRoom) return;
        const message = String(data.message || '').trim().slice(0, 500);
        if (!message) return;
        broadcastToRoom(currentRoom, {
          type: 'chat',
          message,
          username,
        }, null); // send to everyone including sender
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
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
