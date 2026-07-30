// Cerebro de la extensión: maneja la conexión WebSocket de señalización,
// las conexiones WebRTC (host <-> oyentes), y reenvía comandos de sync
// al content script de la pestaña de YouTube Music.

const SIGNALING_URL = 'wss://TU-SERVIDOR-SIGNALING.example.com'; // cambiar por tu servidor desplegado

let ws = null;
let role = null; // 'host' | 'listener' | null
let roomCode = null;
let ytmTabId = null;

// Host: un RTCPeerConnection + DataChannel por oyente
const peerConnections = new Map(); // listenerId -> RTCPeerConnection
const dataChannels = new Map();    // listenerId -> RTCDataChannel

// Listener: una sola conexión hacia el host
let hostPeerConnection = null;
let hostDataChannel = null;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

function connectSignaling() {
  ws = new WebSocket(SIGNALING_URL);

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    await handleSignalingMessage(msg);
  };

  ws.onclose = () => {
    broadcastStatus({ connected: false });
  };

  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'room-created':
      roomCode = msg.roomCode;
      broadcastStatus({ connected: true, role: 'host', roomCode });
      break;

    case 'joined':
      broadcastStatus({ connected: true, role: 'listener', roomCode });
      break;

    case 'listener-joined':
      await hostCreateOfferFor(msg.listenerId);
      break;

    case 'listener-left':
      peerConnections.get(msg.listenerId)?.close();
      peerConnections.delete(msg.listenerId);
      dataChannels.delete(msg.listenerId);
      break;

    case 'host-left':
      broadcastStatus({ connected: false, error: 'El host cerró la sala' });
      cleanupListener();
      break;

    case 'signal':
      await handleSignal(msg);
      break;

    case 'error':
      broadcastStatus({ connected: false, error: msg.message });
      break;
  }
}

// ---------- HOST ----------

async function hostCreateOfferFor(listenerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(listenerId, pc);

  const channel = pc.createDataChannel('sync');
  dataChannels.set(listenerId, channel);
  channel.onopen = async () => {
    // Al conectar, mandar el estado actual inmediatamente
    const state = await getPlaybackStateFromTab();
    if (state) channel.send(JSON.stringify({ type: 'sync', ...state }));
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(listenerId, { candidate: e.candidate });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(listenerId, { sdp: offer });
}

function sendSignal(targetId, data) {
  ws.send(JSON.stringify({ type: 'signal', targetId, data }));
}

// ---------- LISTENER ----------

async function listenerHandleOffer(data) {
  hostPeerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  hostPeerConnection.ondatachannel = (e) => {
    hostDataChannel = e.channel;
    hostDataChannel.onmessage = (msgEvent) => {
      const payload = JSON.parse(msgEvent.data);
      if (payload.type === 'sync') {
        applySyncToTab(payload);
      }
    };
  };

  hostPeerConnection.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'signal', data: { candidate: e.candidate } }));
    }
  };

  await hostPeerConnection.setRemoteDescription(data.sdp);
  const answer = await hostPeerConnection.createAnswer();
  await hostPeerConnection.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'signal', data: { sdp: answer } }));
}

async function handleSignal(msg) {
  if (role === 'host') {
    const pc = peerConnections.get(msg.from);
    if (!pc) return;
    if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate);
  } else {
    if (msg.data.sdp && msg.data.sdp.type === 'offer') {
      await listenerHandleOffer(msg.data);
    } else if (msg.data.candidate) {
      await hostPeerConnection.addIceCandidate(msg.data.candidate);
    }
  }
}

function cleanupListener() {
  hostDataChannel = null;
  hostPeerConnection?.close();
  hostPeerConnection = null;
}

// ---------- Comunicación con content script (pestaña YT Music) ----------

function getPlaybackStateFromTab() {
  if (!ytmTabId) return Promise.resolve(null);
  return chrome.tabs.sendMessage(ytmTabId, { type: 'get-state' }).catch(() => null);
}

function applySyncToTab(state) {
  if (!ytmTabId) return;
  chrome.tabs.sendMessage(ytmTabId, { type: 'apply-sync', ...state }).catch(() => {});
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: 'status-update', ...status }).catch(() => {});
}

function broadcastToListeners(state) {
  for (const channel of dataChannels.values()) {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'sync', ...state }));
    }
  }
}

// ---------- Mensajes desde popup y content script ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'create-jam': {
        role = 'host';
        const [tab] = await chrome.tabs.query({ active: true, url: 'https://music.youtube.com/*' });
        ytmTabId = tab?.id ?? null;
        await connectSignaling();
        ws.send(JSON.stringify({ type: 'create-room' }));
        sendResponse({ ok: true });
        break;
      }

      case 'join-jam': {
        role = 'listener';
        const [tab] = await chrome.tabs.query({ active: true, url: 'https://music.youtube.com/*' });
        ytmTabId = tab?.id ?? null;
        await connectSignaling();
        ws.send(JSON.stringify({ type: 'join-room', roomCode: msg.roomCode.toUpperCase() }));
        sendResponse({ ok: true });
        break;
      }

      case 'leave-jam': {
        ws?.close();
        peerConnections.forEach((pc) => pc.close());
        peerConnections.clear();
        dataChannels.clear();
        cleanupListener();
        role = null;
        roomCode = null;
        sendResponse({ ok: true });
        break;
      }

      // El content script del HOST avisa que cambió la canción o el estado de play/pause
      case 'playback-changed': {
        if (role === 'host') {
          broadcastToListeners(msg.state);
        }
        break;
      }

      case 'get-status': {
        sendResponse({ role, roomCode, connected: !!ws && ws.readyState === WebSocket.OPEN });
        break;
      }
    }
  })();
  return true; // respuesta asíncrona
});
