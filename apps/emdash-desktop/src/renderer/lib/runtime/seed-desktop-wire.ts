import {
  awaitWirePort,
  connect,
  domPortTransport,
  reconnectingTransport,
  webSocketTransport,
  type DomPortLike,
} from '@emdash/wire/rpc';
import { DESKTOP_WIRE_CHANNEL } from '@core/manifests/shared/wire-channels';
import { resetWireConnection, seedWireConnection } from '@core/primitives/wire/browser/connection';
import { isBrowserHost } from './browser-host';

/** Reconnect attempts after a drop before the page reloads (e.g. the sign-in was revoked). */
const BROWSER_RECONNECT_ATTEMPTS = 20;
/**
 * After this long hidden, a page coming back reconnects at once: phones suspend
 * background tabs and their sockets can look open while already dead.
 */
const RESUME_RECONNECT_AFTER_MS = 15_000;

/**
 * The production seed: called once by the renderer bootstrap before React mounts.
 * This is the only host-owned wire code — port acquisition over the Electron
 * preload bridge, or a WebSocket to the serving Emdash under browser access.
 * Everything downstream reaches the wire through the core seam.
 */
export function seedDesktopWire(): void {
  seedWireConnection(async () => {
    if (isBrowserHost) return connectBrowser();
    const portPromise = awaitWirePort(window, { channel: DESKTOP_WIRE_CHANNEL });
    await window.electronAPI.requestWirePort(DESKTOP_WIRE_CHANNEL);
    return connect(domPortTransport((await portPromise) as DomPortLike));
  });
}

/**
 * Browser access keeps its page across dropped connections: the socket reconnects with
 * backoff and the connection re-attaches every live model and replays held calls, so
 * what is on screen (open conversations, drafts, scroll) survives a phone locking or
 * switching apps. Only when reconnecting keeps failing does the page reload.
 */
async function connectBrowser() {
  let current: WebSocket | null = null;
  const transport = reconnectingTransport(
    async () => {
      current = await openBrowserSocket();
      return webSocketTransport(current);
    },
    {
      backoffMs: [250, 500, 1000, 2000, 5000],
      shouldRetry: (_error, { attempt, isReconnect }) =>
        isReconnect ? attempt < BROWSER_RECONNECT_ATTEMPTS : attempt < 3,
    }
  );
  transport.onTerminalFailure(() => window.location.reload());
  await transport.ready();

  let hiddenAt: number | null = null;
  const reconnectIfStale = () => {
    const wasHiddenLong = hiddenAt !== null && Date.now() - hiddenAt > RESUME_RECONNECT_AFTER_MS;
    hiddenAt = null;
    // Closing the (possibly half-dead) socket makes the transport open a fresh one.
    if (wasHiddenLong && current?.readyState === WebSocket.OPEN) current.close();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else reconnectIfStale();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      hiddenAt ??= 0;
      reconnectIfStale();
    }
  });
  window.addEventListener('online', () => {
    if (current?.readyState === WebSocket.OPEN) current.close();
  });
  return connect(transport);
}

async function openBrowserSocket(): Promise<WebSocket> {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${window.location.host}/wire`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener(
      'error',
      () => {
        void reloadIfSignedOut();
        reject(new Error('Could not reach Emdash'));
      },
      { once: true }
    );
  });
  return socket;
}

/**
 * A refused socket is either the network or this device being signed out on the
 * computer: the server answers the latter with 401, and the reload shows its sign-in
 * page at once instead of after every reconnect attempt.
 */
async function reloadIfSignedOut(): Promise<void> {
  try {
    const response = await fetch('/info', { cache: 'no-store' });
    if (response.status === 401) window.location.reload();
  } catch {
    // Unreachable: keep reconnecting.
  }
}

// Dev-server edits to seeding modules must not leave a stale connection behind.
import.meta.hot?.dispose(() => resetWireConnection());
