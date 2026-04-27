const http = require('http');
const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const MAX_MSG_BYTES = 16 * 1024;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 10_000;

const ALLOWED_TYPES = new Set([
  'hello',
  'abilityDamage',
  'abilityHealing',
  'abilityCast',
  'summaryPing',
]);

// Room keys arriving as query params are already hashed by the userscript,
// but we still enforce a safe character set and sane length bounds.
const VALID_ROOM_RE = /^[a-zA-Z0-9_-]{4,128}$/;

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── WebSocket upgrade ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let room;
  try {
    const url = new URL(req.url, 'http://localhost');
    room = url.searchParams.get('room') ?? '';
  } catch {
    socket.destroy();
    return;
  }

  if (!VALID_ROOM_RE.test(room)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid or missing room parameter');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.room = room;
    ws.clientId = randomUUID();
    ws._msgCount = 0;
    ws._windowStart = Date.now();
    wss.emit('connection', ws);
  });
});

// ── Connection handling ──────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const { room, clientId } = ws;

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);
  peers.add(ws);

  ws.send(JSON.stringify({
    type: 'relayReady',
    room,
    clientId,
    connected: peers.size,
    ts: Date.now(),
  }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, 'Binary frames not accepted');
      return;
    }

    if (data.length > MAX_MSG_BYTES) {
      ws.close(1009, 'Message too large');
      return;
    }

    // Sliding-window rate limit
    const now = Date.now();
    if (now - ws._windowStart > RATE_LIMIT_WINDOW_MS) {
      ws._windowStart = now;
      ws._msgCount = 0;
    }
    if (++ws._msgCount > RATE_LIMIT_MAX) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string' || !ALLOWED_TYPES.has(msg.type)) return;

    const outbound = JSON.stringify({
      ...msg,
      senderClientId: clientId,
      relayTs: Date.now(),
    });

    const roomPeers = rooms.get(room);
    if (!roomPeers) return;

    for (const peer of roomPeers) {
      if (peer.readyState === peer.OPEN) {
        peer.send(outbound);
      }
    }
  });

  ws.on('close', () => {
    const roomPeers = rooms.get(room);
    if (roomPeers) {
      roomPeers.delete(ws);
      if (roomPeers.size === 0) rooms.delete(room);
    }
  });

  ws.on('error', () => ws.terminate());
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`VoidIdle relay listening on port ${PORT}`);
});
