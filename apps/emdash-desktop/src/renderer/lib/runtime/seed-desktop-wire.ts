import {
  awaitWirePort,
  connect,
  domPortTransport,
  webSocketTransport,
  type DomPortLike,
} from '@emdash/wire/rpc';
import { DESKTOP_WIRE_CHANNEL } from '@core/manifests/shared/wire-channels';
import { resetWireConnection, seedWireConnection } from '@core/primitives/wire/browser/connection';
import { isBrowserHost } from './browser-host';

/** After the socket drops, reload: the page reconnects and restores its state. */
const BROWSER_RECONNECT_DELAY_MS = 2_000;

/**
 * The production seed: called once by the renderer bootstrap before React mounts.
 * This is the only host-owned wire code — port acquisition over the Electron
 * preload bridge, or a WebSocket to the serving Emdash under browser access.
 * Everything downstream reaches the wire through the core seam.
 */
export function seedDesktopWire(): void {
  seedWireConnection(async () => {
    if (isBrowserHost) return connect(webSocketTransport(await openBrowserSocket()));
    const portPromise = awaitWirePort(window, { channel: DESKTOP_WIRE_CHANNEL });
    await window.electronAPI.requestWirePort(DESKTOP_WIRE_CHANNEL);
    return connect(domPortTransport((await portPromise) as DomPortLike));
  });
}

async function openBrowserSocket(): Promise<WebSocket> {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${window.location.host}/wire`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not reach Emdash')), {
      once: true,
    });
  });
  socket.addEventListener('close', () => {
    setTimeout(() => window.location.reload(), BROWSER_RECONNECT_DELAY_MS);
  });
  return socket;
}

// Dev-server edits to seeding modules must not leave a stale connection behind.
import.meta.hot?.dispose(() => resetWireConnection());
