// Signaling server para WebRTC + endpoint proxy de credenciales TURN.
// El WebSocket solo pasa mensajes SDP/ICE entre host y oyentes. NO transporta audio/video.
// El endpoint /turn-credentials guarda el API key de Metered SOLO en el servidor (variable de entorno),
// nunca en el código de la extensión ni en git.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Estas dos variables se configuran en Render → tu servicio → "Environment" → Add Environment Variable.
// NUNCA se escriben en el código ni se suben a GitHub.
const TURN_APP_NAME = process.env.TURN_APP_NAME || '';
const TURN_API_KEY = process.env.TURN_API_KEY || '';

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/turn-credentials') {
    res.setHeader('Access-Control-Allow-Origin', '*'); // la extensión llama desde extension://, necesita CORS abierto

    if (!TURN_APP_NAME || !TURN_API_KEY) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([])); // sin TURN configurado: la extensión cae a solo-STUN
      return;
    }

    try {
      const upstream = await fetch(
        `https://${TURN_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${TURN_API_KEY}`
      );
      const data = await upstream.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[turn-credentials] error pidiendo a Metered:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

// rooms: Map<roomCode, { host: ws|null, listeners: Map<clientId, ws> }>
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.roomCode = null;
  ws.role = null;
  console.log(`[conexión] cliente ${ws.id} conectado`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        const code = genRoomCode();
        rooms.set(code, { host: ws, listeners: new Map() });
        ws.roomCode = code;
        ws.role = 'host';
        console.log(`[sala creada] ${code} por cliente ${ws.id}`);
        send(ws, { type: 'room-created', roomCode: code });
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomCode);
        if (!room || !room.host) {
          console.log(`[unión fallida] cliente ${ws.id} intentó sala ${msg.roomCode} (no existe)`);
          send(ws, { type: 'error', message: 'Sala no existe o el host se desconectó' });
          return;
        }
        ws.roomCode = msg.roomCode;
        ws.role = 'listener';
        room.listeners.set(ws.id, ws);
        console.log(`[unión exitosa] cliente ${ws.id} entró a sala ${msg.roomCode}`);
        send(room.host, { type: 'listener-joined', listenerId: ws.id });
        send(ws, { type: 'joined', hostPresent: true });
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        if (ws.role === 'host') {
          const target = room.listeners.get(msg.targetId);
          send(target, { type: 'signal', from: 'host', data: msg.data });
        } else {
          send(room.host, { type: 'signal', from: ws.id, data: msg.data });
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (ws.role === 'host') {
      for (const listener of room.listeners.values()) {
        send(listener, { type: 'host-left' });
      }
      rooms.delete(ws.roomCode);
    } else if (ws.role === 'listener') {
      room.listeners.delete(ws.id);
      send(room.host, { type: 'listener-left', listenerId: ws.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server escuchando en puerto ${PORT}`);
  console.log(TURN_APP_NAME ? '[TURN] Configurado vía variables de entorno' : '[TURN] No configurado, solo STUN');
});
