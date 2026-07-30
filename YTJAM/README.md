# YT Music Jam — extensión de navegador

Sincroniza YouTube Music entre un host y varios oyentes, tipo Jam de Spotify.

## Arquitectura

```
[Host: content script]  <-- controla <video> de YT Music
        |
        v
[Host: background.js]  <-- detecta cambios, maneja WebRTC
        |
   (WebSocket, solo señalización SDP/ICE)
        |
        v
[Servidor signaling]  <-- Node + ws, NO transporta audio
        |
        v
[Oyente: background.js]  <-- recibe por DataChannel P2P (WebRTC)
        |
        v
[Oyente: content script]  <-- fuerza <video> a igualar al host
```

Una vez que el DataChannel WebRTC queda abierto entre host y oyente, los mensajes de sincronización (`videoId`, `currentTime`, `isPlaying`) viajan **directo P2P**, sin pasar por el servidor. El servidor solo sirve para que ambos se encuentren al inicio (intercambio de ofertas/candidatos ICE).

## ⚠️ Limitación importante que debes resolver antes de usar en serio

Los `background.js` de Manifest V3 son **service workers que Chrome apaga cuando están inactivos** (normalmente a los 30 segundos sin actividad). Una `RTCPeerConnection` y un `WebSocket` abiertos ahí **se pueden cortar** si el navegador decide dormir el worker, especialmente en el oyente que no genera actividad constante.

Mitigaciones posibles (no implementadas todavía, elige una):
1. **Offscreen Document API** (`chrome.offscreen`): mueve el WebRTC a un documento oculto que no se suspende igual que el service worker. Es la solución recomendada por Google para este caso exacto.
2. **Keepalive con `chrome.alarms`**: crear una alarma cada 20s que despierte el worker y haga ping. Parche, no solución real — puede perder paquetes igual.
3. Aceptar el riesgo para una v1 de prueba entre pocos amigos y ver si el corte ocurre en la práctica.

Recomiendo (1) si esto va a usarse seguido. Puedo implementarlo si quieres — es mover el contenido de `background.js` a un `offscreen.html` + pequeño puente de mensajes.

## Pasos para desplegar

### 1. Servidor de señalización

```bash
cd signaling-server
npm install
npm start
```

Esto corre localmente en `ws://localhost:8080`. Para que tus amigos se conecten desde afuera, necesitas desplegarlo en algún host con WebSocket support:

- **Render.com** (gratis, fácil): crear "Web Service", conectar el repo, build command `npm install`, start command `npm start`.
- **Railway.app**: similar, deploy directo desde carpeta.
- **Fly.io**: `fly launch` dentro de `signaling-server/`.

Cuando esté desplegado, tendrás una URL tipo `wss://tu-app.onrender.com` (nota: `wss://`, no `https://`).

### 2. Configurar la extensión

Edita `extension/background.js`, línea 5:

```js
const SIGNALING_URL = 'wss://TU-SERVIDOR-SIGNALING.example.com';
```

Reemplaza por la URL real de tu servidor desplegado.

### 3. Cargar la extensión en el navegador

Funciona igual en Chrome, Opera GX, Opera y Brave (todos son Chromium):

1. Abre `chrome://extensions` (o `opera://extensions` / `brave://extensions`)
2. Activa "Modo de desarrollador" (esquina superior derecha)
3. Clic en "Cargar descomprimida" / "Load unpacked"
4. Selecciona la carpeta `extension/`
5. Debería aparecer el ícono de YT Music Jam en la barra

### 4. Probar

1. Abre `music.youtube.com` y pon play en algo
2. Clic en el ícono de la extensión → "Crear jam"
3. Copia el código de 5 caracteres
4. Tu amigo abre `music.youtube.com`, clic en el ícono → pega el código → "Unirse"
5. Cuando tú (host) cambies de canción o le des play/pausa, debería reflejarse en su pantalla

## Archivos

```
extension/
  manifest.json          — configuración de la extensión
  background.js           — WebRTC + señalización (el "cerebro")
  content/ytm-control.js   — controla el <video> de YouTube Music
  popup.html/css/js        — interfaz al hacer clic en el ícono
  icons/                   — iconos placeholder (reemplázalos si quieres)

signaling-server/
  server.js                — servidor WebSocket de señalización
  package.json
```

## Próximos pasos sugeridos

- [ ] Resolver la suspensión del service worker (offscreen document)
- [ ] Manejar reconexión automática si se cae el WebSocket
- [ ] Íconos reales (los actuales son placeholder generado)
- [ ] Firefox necesita `background.scripts` en vez de `service_worker` — ajuste menor al manifest si migras
