const viewIdle = document.getElementById('view-idle');
const viewConnected = document.getElementById('view-connected');
const viewNoTab = document.getElementById('view-no-tab');
const errorMsg = document.getElementById('error-msg');

function showView(view) {
  [viewIdle, viewConnected, viewNoTab].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

async function checkYtmTabOpen() {
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  return tabs.length > 0;
}

async function refreshView() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });

  if (status.connected && status.roomCode) {
    showView(viewConnected);
    document.getElementById('role-label').textContent =
      status.role === 'host' ? 'Eres el host' : 'Eres oyente';
    document.getElementById('room-code-display').textContent = status.roomCode;
    document.getElementById('hint-text').textContent =
      status.role === 'host'
        ? 'Comparte este código con tus amigos para que se unan.'
        : 'Escuchando la música del host en tiempo real.';
    return;
  }

  const hasTab = await checkYtmTabOpen();
  if (!hasTab) {
    showView(viewNoTab);
    return;
  }

  showView(viewIdle);
}

const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');

btnCreate.addEventListener('click', async () => {
  errorMsg.textContent = '';
  const hasTab = await checkYtmTabOpen();
  if (!hasTab) {
    showView(viewNoTab);
    return;
  }
  btnCreate.disabled = true;
  btnJoin.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'create-jam' });
  if (res && res.error) errorMsg.textContent = res.error;
  btnCreate.disabled = false;
  btnJoin.disabled = false;
  setTimeout(refreshView, 500);
});

btnJoin.addEventListener('click', async () => {
  errorMsg.textContent = '';
  const code = document.getElementById('input-code').value.trim();
  if (code.length !== 5) {
    errorMsg.textContent = 'El código debe tener 5 caracteres.';
    return;
  }
  const hasTab = await checkYtmTabOpen();
  if (!hasTab) {
    showView(viewNoTab);
    return;
  }
  btnCreate.disabled = true;
  btnJoin.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'join-jam', roomCode: code });
  if (res && res.error) errorMsg.textContent = res.error;
  btnCreate.disabled = false;
  btnJoin.disabled = false;
  setTimeout(refreshView, 500);
});

document.getElementById('btn-leave').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'leave-jam' });
  refreshView();
});

document.getElementById('btn-copy').addEventListener('click', () => {
  const code = document.getElementById('room-code-display').textContent;
  navigator.clipboard.writeText(code);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status-update') {
    if (msg.error) errorMsg.textContent = msg.error;
    refreshView();
  }
});

refreshView();
