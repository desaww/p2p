const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const port = process.env.PORT || 8080;

// 1. Statische Dateien aus ../public bedienen
app.use(express.static(path.join(__dirname, '../public')));

// 2. HTTP-Server und WebSocket.Server einrichten
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 3. rooms-Datenstruktur
const rooms = new Map(); // z.B. rooms.set('room1', new Set([client1, client2]))

wss.on('connection', (ws) => {
  // einfache ID für jeden Client
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.room = null;

  const send = (targetWs, obj) => {
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(JSON.stringify(obj));
    }
  };

  // Helper: finde Client by id in einem Room
  const findClientInRoom = (room, id) => {
    const set = rooms.get(room);
    if (!set) return null;
    for (const client of set) {
      if (client.id === id) return client;
    }
    return null;
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      console.warn('Nicht-JSON erhalten:', raw);
      return;
    }

    if (msg.type === 'join') {
      const room = msg.room || 'default';
      ws.room = room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);

      // Liste der bestehenden Peers (nur IDs)
      const peers = Array.from(rooms.get(room))
        .filter(c => c !== ws)
        .map(c => c.id);

      // Antworte dem Joiner mit seiner id und vorhandenen peers
      send(ws, { type: 'joined', id: ws.id, peers });

      // Benachrichtige die anderen im Raum über den neuen Peer
      for (const client of rooms.get(room)) {
        if (client !== ws) {
          send(client, { type: 'peer-joined', id: ws.id });
        }
      }

      console.log(`Client ${ws.id} joined room ${room} (peers: ${peers.join(',')})`);
      return;
    }

    if (msg.type === 'signal') {
      // erwartet: { type: 'signal', to: '<peerId>', data: {...} }
      const room = ws.room;
      if (!room) return;
      const target = findClientInRoom(room, msg.to);
      if (!target) {
        console.warn(`Target ${msg.to} nicht gefunden in room ${room}`);
        return;
      }
      // leite weiter: include sender id
      send(target, { type: 'signal', from: ws.id, data: msg.data });
      return;
    }

    // andere message-types optional behandeln
    console.log('Unbehandelte Nachricht:', msg);
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room || !rooms.has(room)) return;
    const set = rooms.get(room);
    set.delete(ws);
    // notify remaining peers
    for (const client of set) {
      send(client, { type: 'peer-left', id: ws.id });
    }
    if (set.size === 0) rooms.delete(room);
    console.log(`Client ${ws.id} left room ${room}`);
  });

  // optional: sende die id direkt beim connect (falls client das will)
  send(ws, { type: 'hello', id: ws.id });
});


server.listen(port, () => {
  console.log('Server started at http://localhost:' + port);
});