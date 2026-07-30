// Este documento offscreen NO se suspende como el service worker.
// Aquí vive el WebSocket de señalización y todas las RTCPeerConnection.
// background.js (service worker) solo reenvía mensajes hacia/desde acá.

const SIGNALING_URL = 'wss://ytjam.onrender.com'; // servidor desplegado

let ws = null;
let role = null; // 'host' | 'listener' | null
let roomCode = null;
let busy = false; // evita conexiones concurrentes por doble clic

const peerConnections = new Map(); // listenerId -> RTCPeerConnection
const dataChannels = new Map();    // listenerId -> RTCDataChannel
const pendingHostCandidates = new Map(); // listenerId -> candidatos ICE recibidos antes de setRemoteDescription

let hostPeerConnection = null;
let hostDataChannel = null;
let pendingListenerCandidates = []; // candidatos ICE recibidos antes de setRemoteDescription (lado oyente)

let outboundQueue = []; // mensajes en espera si el WebSocket aún no está OPEN

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

function toBackground(msg) {
  chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});
}

// Envía por WebSocket; si aún no está abierto, encola y despacha al abrir.
// Esto elimina el error "Still in CONNECTING state" causado por enviar antes de tiempo.
function sendWsMessage(payload) {
  const json = JSON.stringify(payload);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(json);
  } else {
    outboundQueue.push(json);
  }
}

function flushOutboundQueue() {
  while (outboundQueue.length && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(outboundQueue.shift());
  }
}

function connectSignaling() {
  // Si había una conexión previa (de un intento anterior), ciérrala primero
  // para que no queden dos WebSocket compartiendo la misma variable `ws`.
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  outboundQueue = [];

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(SIGNALING_URL);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return; // esta conexión ya fue reemplazada, ignorar
      resolve();
      flushOutboundQueue();
    };

    socket.onerror = (err) => {
      if (ws !== socket) return;
      reject(err);
    };

    socket.onmessage = async (event) => {
      if (ws !== socket) return; // ignorar mensajes de una conexión vieja/reemplazada
      const msg = JSON.parse(event.data);
      await handleSignalingMessage(msg);
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      toBackground({ type: 'status-update', connected: false });
    };
  });
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'room-created':
      roomCode = msg.roomCode;
      toBackground({ type: 'status-update', connected: true, role: 'host', roomCode });
      break;

    case 'joined':
      toBackground({ type: 'status-update', connected: true, role: 'listener', roomCode });
      break;

    case 'listener-joined':
      await hostCreateOfferFor(msg.listenerId);
      break;

    case 'listener-left':
      peerConnections.get(msg.listenerId)?.close();
      peerConnections.delete(msg.listenerId);
      dataChannels.delete(msg.listenerId);
      pendingHostCandidates.delete(msg.listenerId);
      break;

    case 'host-left':
      toBackground({ type: 'status-update', connected: false, error: 'El host cerró la sala' });
      cleanupListener();
      break;

    case 'signal':
      await handleSignal(msg);
      break;

    case 'error':
      toBackground({ type: 'status-update', connected: false, error: msg.message });
      break;
  }
}

// ---------- HOST ----------

async function hostCreateOfferFor(listenerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(listenerId, pc);
  pendingHostCandidates.set(listenerId, []);

  const channel = pc.createDataChannel('sync');
  dataChannels.set(listenerId, channel);
  channel.onopen = () => {
    toBackground({ type: 'request-current-state' });
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendWsMessage({ type: 'signal', targetId: listenerId, data: { candidate: e.candidate } });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWsMessage({ type: 'signal', targetId: listenerId, data: { sdp: offer } });
}

// ---------- LISTENER ----------

async function listenerHandleOffer(data) {
  hostPeerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pendingListenerCandidates = [];

  hostPeerConnection.ondatachannel = (e) => {
    hostDataChannel = e.channel;
    hostDataChannel.onmessage = (msgEvent) => {
      const payload = JSON.parse(msgEvent.data);
      if (payload.type === 'sync') {
        toBackground({ type: 'apply-sync-to-tab', state: payload });
      }
    };
  };

  hostPeerConnection.onicecandidate = (e) => {
    if (e.candidate) sendWsMessage({ type: 'signal', data: { candidate: e.candidate } });
  };

  await hostPeerConnection.setRemoteDescription(data.sdp);
  const answer = await hostPeerConnection.createAnswer();
  await hostPeerConnection.setLocalDescription(answer);
  sendWsMessage({ type: 'signal', data: { sdp: answer } });

  // Aplicar candidatos ICE que hayan llegado antes de terminar este setup
  for (const candidate of pendingListenerCandidates) {
    await hostPeerConnection.addIceCandidate(candidate);
  }
  pendingListenerCandidates = [];
}

// BUG CORREGIDO: antes esta función ignoraba el SDP de respuesta (answer) del oyente
// cuando el rol era 'host', por lo que la conexión P2P nunca terminaba de negociarse.
async function handleSignal(msg) {
  if (role === 'host') {
    const pc = peerConnections.get(msg.from);
    if (!pc) return;

    if (msg.data.sdp) {
      // Respuesta del oyente: establecerla como descripción remota
      await pc.setRemoteDescription(msg.data.sdp);
      const queued = pendingHostCandidates.get(msg.from) || [];
      for (const candidate of queued) {
        await pc.addIceCandidate(candidate);
      }
      pendingHostCandidates.set(msg.from, []);
    } else if (msg.data.candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(msg.data.candidate);
      } else {
        // Aún no tenemos remote description: encolar para aplicar después
        const queue = pendingHostCandidates.get(msg.from) || [];
        queue.push(msg.data.candidate);
        pendingHostCandidates.set(msg.from, queue);
      }
    }
  } else {
    if (msg.data.sdp && msg.data.sdp.type === 'offer') {
      await listenerHandleOffer(msg.data);
    } else if (msg.data.candidate) {
      if (hostPeerConnection && hostPeerConnection.remoteDescription) {
        await hostPeerConnection.addIceCandidate(msg.data.candidate);
      } else {
        pendingListenerCandidates.push(msg.data.candidate);
      }
    }
  }
}

function cleanupListener() {
  hostDataChannel = null;
  hostPeerConnection?.close();
  hostPeerConnection = null;
  pendingListenerCandidates = [];
}

function broadcastToListeners(state) {
  for (const channel of dataChannels.values()) {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'sync', ...state }));
    }
  }
}

function resetAll() {
  ws?.close();
  ws = null;
  outboundQueue = [];
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();
  dataChannels.clear();
  pendingHostCandidates.clear();
  cleanupListener();
  role = null;
  roomCode = null;
  busy = false;
}

// ---------- Mensajes desde background.js ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  (async () => {
    switch (msg.type) {
      case 'create-jam': {
        if (busy) { sendResponse({ ok: false, error: 'Ya hay una conexión en curso, espera un momento' }); break; }
        busy = true;
        role = 'host';
        try {
          await connectSignaling();
          sendWsMessage({ type: 'create-room' });
          sendResponse({ ok: true });
        } catch (err) {
          toBackground({ type: 'status-update', connected: false, error: 'No se pudo conectar al servidor de señalización' });
          sendResponse({ ok: false });
        } finally {
          busy = false;
        }
        break;
      }

      case 'join-jam': {
        if (busy) { sendResponse({ ok: false, error: 'Ya hay una conexión en curso, espera un momento' }); break; }
        busy = true;
        role = 'listener';
        try {
          await connectSignaling();
          sendWsMessage({ type: 'join-room', roomCode: msg.roomCode.toUpperCase() });
          sendResponse({ ok: true });
        } catch (err) {
          toBackground({ type: 'status-update', connected: false, error: 'No se pudo conectar al servidor de señalización' });
          sendResponse({ ok: false });
        } finally {
          busy = false;
        }
        break;
      }

      case 'leave-jam': {
        resetAll();
        sendResponse({ ok: true });
        break;
      }

      case 'playback-changed': {
        if (role === 'host') broadcastToListeners(msg.state);
        sendResponse({ ok: true });
        break;
      }

      case 'current-state-response': {
        if (role === 'host') broadcastToListeners(msg.state);
        break;
      }

      case 'get-status': {
        sendResponse({ role, roomCode, connected: !!ws && ws.readyState === WebSocket.OPEN });
        break;
      }
    }
  })();

  return true; // respuesta async
});
