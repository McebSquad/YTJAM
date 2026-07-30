// Signaling server mínimo para WebRTC.
// Solo pasa mensajes SDP/ICE entre host y oyentes. NO transporta audio/video ni estado de reproducción.
// Una vez conectados por WebRTC, todo el tráfico va P2P directo entre navegadores.

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// rooms: Map<roomCode, { host: ws|null, listeners: Map<clientId, ws> }>
const rooms = new Map();

function genRoomCode() {
  // Código corto legible: 5 caracteres, sin 0/O/1/I para evitar confusión
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
        // Avisar al host que hay un nuevo oyente esperando conexión WebRTC
        send(room.host, { type: 'listener-joined', listenerId: ws.id });
        send(ws, { type: 'joined', hostPresent: true });
        break;
      }

      // Retransmisión de señalización WebRTC (SDP offer/answer, ICE candidates)
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
      // Host se fue: avisar a todos los oyentes y cerrar la sala
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

console.log(`Signaling server escuchando en puerto ${PORT}`);
