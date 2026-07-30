// Vive dentro de music.youtube.com.
// - Como HOST: observa el reproductor y avisa a background cuando cambia canción o play/pause.
// - Como LISTENER: recibe comandos de sync y fuerza el reproductor a igualarlos.

const SYNC_TOLERANCE_SECONDS = 1.5; // margen antes de forzar un seek (evita micro-correcciones constantes)

function getVideoEl() {
  return document.querySelector('video');
}

function getCurrentVideoId() {
  // YT Music expone el videoId actual en la URL del reproductor embebido o en el store interno.
  // Método robusto: leer del layout del reproductor via atributo del app-layout, con fallback a la URL.
  const url = new URL(location.href);
  const watchId = url.searchParams.get('v');
  if (watchId) return watchId;

  const player = document.querySelector('ytmusic-player-bar');
  return player?.getAttribute('data-video-id') || null;
}

function getPlaybackState() {
  const video = getVideoEl();
  if (!video) return null;
  return {
    videoId: getCurrentVideoId(),
    currentTime: video.currentTime,
    isPlaying: !video.paused,
    timestamp: Date.now()
  };
}

// ---------- HOST: detectar cambios y notificar ----------

let lastVideoId = null;
let lastIsPlaying = null;

function notifyIfChanged() {
  const state = getPlaybackState();
  if (!state) return;

  const changed = state.videoId !== lastVideoId || state.isPlaying !== lastIsPlaying;
  if (changed) {
    lastVideoId = state.videoId;
    lastIsPlaying = state.isPlaying;
    chrome.runtime.sendMessage({ type: 'playback-changed', state });
  }
}

function watchPlayer() {
  const video = getVideoEl();
  if (!video) {
    setTimeout(watchPlayer, 1000); // reproductor aún no carga, reintentar
    return;
  }

  video.addEventListener('play', notifyIfChanged);
  video.addEventListener('pause', notifyIfChanged);
  video.addEventListener('ended', notifyIfChanged);

  // Cambios de canción no siempre disparan un evento limpio del <video>;
  // un MutationObserver sobre la barra del reproductor cubre navegación por clic/autoplay.
  const playerBar = document.querySelector('ytmusic-player-bar');
  if (playerBar) {
    const observer = new MutationObserver(() => notifyIfChanged());
    observer.observe(playerBar, { attributes: true, subtree: true, childList: true });
  }

  // Heartbeat: corrige drift de tiempo cada 2s aunque no haya cambio de canción
  setInterval(notifyIfChanged, 2000);
}

watchPlayer();

// ---------- LISTENER: aplicar sync recibido ----------

function applySync(state) {
  const video = getVideoEl();
  if (!video) return;

  const currentVideoId = getCurrentVideoId();

  if (state.videoId && state.videoId !== currentVideoId) {
    // Cambiar de canción: navegar a la URL del nuevo video
    location.href = `https://music.youtube.com/watch?v=${state.videoId}`;
    return; // tras la navegación, este script se reinyecta y sincroniza currentTime aparte
  }

  // Compensar la latencia de red: sumar el tiempo transcurrido desde que el host generó el estado
  const elapsed = (Date.now() - state.timestamp) / 1000;
  const expectedTime = state.currentTime + (state.isPlaying ? elapsed : 0);

  if (Math.abs(video.currentTime - expectedTime) > SYNC_TOLERANCE_SECONDS) {
    video.currentTime = expectedTime;
  }

  if (state.isPlaying && video.paused) video.play();
  if (!state.isPlaying && !video.paused) video.pause();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-state') {
    sendResponse(getPlaybackState());
  } else if (msg.type === 'apply-sync') {
    applySync(msg);
  }
  return true;
});
