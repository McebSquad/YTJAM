// Service worker: puente liviano entre popup, content script y el documento offscreen.
// TODA la lógica de WebRTC/WebSocket vive en offscreen.js (no se duerme).
// Este archivo se puede suspender sin problema porque no mantiene estado crítico.

let ytmTabId = null;
let creatingOffscreen = null; // evita crear el offscreen doc dos veces en paralelo

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WEB_RTC'],
    justification: 'Mantener conexiones WebRTC activas sin que el service worker las corte al dormirse'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function findYtmTab() {
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  return tabs[0]?.id ?? null;
}

// ---------- Mensajes desde el popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Mensajes que vienen del offscreen document, destinados al background
  if (msg.target === 'background') {
    handleFromOffscreen(msg, sendResponse);
    return true;
  }

  // Mensajes que vienen del content script (pestaña YT Music)
  if (sender.tab && msg.type === 'playback-changed') {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'playback-changed', state: msg.state }).catch(() => {});
    return false;
  }

  // Mensajes desde el popup
  (async () => {
    switch (msg.type) {
      case 'create-jam': {
        ytmTabId = await findYtmTab();
        await ensureOffscreenDocument();
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'create-jam' });
        sendResponse(res);
        break;
      }

      case 'join-jam': {
        ytmTabId = await findYtmTab();
        await ensureOffscreenDocument();
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'join-jam', roomCode: msg.roomCode });
        sendResponse(res);
        break;
      }

      case 'leave-jam': {
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'leave-jam' }).catch(() => ({ ok: true }));
        sendResponse(res);
        break;
      }

      case 'get-status': {
        const hasOffscreen = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
        if (!hasOffscreen) {
          sendResponse({ role: null, roomCode: null, connected: false });
          break;
        }
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'get-status' }).catch(() => ({ role: null, roomCode: null, connected: false }));
        sendResponse(res);
        break;
      }
    }
  })();

  return true; // respuesta async
});

// ---------- Mensajes desde offscreen.js ----------

function handleFromOffscreen(msg, sendResponse) {
  switch (msg.type) {
    case 'status-update':
      // Reenviar al popup si está abierto (si no hay listener, se ignora silenciosamente)
      chrome.runtime.sendMessage({ type: 'status-update', ...msg }).catch(() => {});
      break;

    case 'request-current-state':
      // El offscreen necesita el estado actual del reproductor para mandarlo a un oyente nuevo
      (async () => {
        if (!ytmTabId) ytmTabId = await findYtmTab();
        if (!ytmTabId) return;
        const state = await chrome.tabs.sendMessage(ytmTabId, { type: 'get-state' }).catch(() => null);
        if (state) {
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'current-state-response', state }).catch(() => {});
        }
      })();
      break;

    case 'apply-sync-to-tab':
      (async () => {
        if (!ytmTabId) ytmTabId = await findYtmTab();
        if (!ytmTabId) return;
        chrome.tabs.sendMessage(ytmTabId, { type: 'apply-sync', ...msg.state }).catch(() => {});
      })();
      break;
  }
}
