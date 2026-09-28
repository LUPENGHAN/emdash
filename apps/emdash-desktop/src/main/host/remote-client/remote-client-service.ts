import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  client,
  connect,
  forwardController,
  reconnectingTransport,
  webSocketTransport,
  type Connection,
  type Controller,
  type ReconnectingTransport,
  type WebSocketLike,
} from '@emdash/wire/rpc';
import { createWebSocketStream, WebSocket } from 'ws';
import {
  LOCAL_ONLY_DOMAINS,
  type RemoteClientService,
  type RemoteClientState,
  type RemoteServer,
  type RemoteServerInfo,
} from '@core/features/remote-access/api';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import { desktopDomainContracts } from '@core/manifests/shared/domain-contracts';
import { startBrowserProxy, type BrowserProxy } from './browser-proxy';

const COOKIE = 'emdash_remote';
const CONNECT_TIMEOUT_MS = 10_000;
const INFO_TIMEOUT_MS = 5_000;

type Stored = { activeServerId: string | null; servers: RemoteServer[] };

export type RemoteClientDeps = {
  /** JSON file for the saved computers; tokens go to `secrets`. */
  storePath: string;
  secrets: {
    read(serverId: string): Promise<string | null>;
    write(serverId: string, token: string): Promise<void>;
    remove(serverId: string): Promise<void>;
  };
  localVersion: string;
  /** Installs (or clears) the controllers that answer for the other computer. */
  setRouting: (controllers: Promise<Record<string, Controller> | null>) => void;
  setBrowserProxyPort: (port: number | null) => Promise<void>;
  reloadWindow: () => void;
  warn?: (message: string, details: Record<string, unknown>) => void;
  /**
   * Starts another app instance: with `server`, one on that computer's own profile,
   * handed the computer and its sign-in; without, the main window (this computer).
   */
  launchWindow?: (server: { server: RemoteServer; token: string } | null) => Promise<void>;
  /**
   * Set in a window opened for one computer: that computer and its sign-in, saved into
   * this window's profile and connected at startup.
   */
  windowServer?: { server: RemoteServer; token: string } | null;
  /** Names the computer the window drives in its title (null: this computer). */
  setWindowTitle?: (computerName: string | null) => void;
};

type ActiveRemote = {
  server: RemoteServer;
  transport: ReconnectingTransport;
  connection: Connection;
  proxy: BrowserProxy;
};

export type ManagedRemoteClientService = RemoteClientService & {
  /** Reconnects to the computer saved as active; falls back to this one if unreachable. */
  start(): Promise<void>;
  dispose(): Promise<void>;
};

/**
 * Lets this window drive another computer's Emdash (its Remote access server): the
 * desktop wire's domains, except {@link LOCAL_ONLY_DOMAINS}, are forwarded over a
 * reconnecting WebSocket, and the built-in browser goes through that computer.
 */
export function createRemoteClientService(deps: RemoteClientDeps): ManagedRemoteClientService {
  let active: ActiveRemote | null = null;
  let connection: RemoteClientState['connection'] = 'local';
  let error: string | null = null;
  let versionMismatch: RemoteClientState['versionMismatch'] = null;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  const load = async (): Promise<Stored> => {
    try {
      const parsed = JSON.parse(await readFile(deps.storePath, 'utf8')) as Partial<Stored>;
      return { activeServerId: parsed.activeServerId ?? null, servers: parsed.servers ?? [] };
    } catch {
      return { activeServerId: null, servers: [] };
    }
  };
  const save = async (stored: Stored): Promise<void> => {
    await mkdir(dirname(deps.storePath), { recursive: true });
    await writeFile(deps.storePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  };

  const disconnect = async (): Promise<void> => {
    const current = active;
    active = null;
    if (!current) return;
    current.transport.close();
    await current.proxy.close();
  };

  const open = async (server: RemoteServer): Promise<ActiveRemote> => {
    const token = await deps.secrets.read(server.id);
    if (!token) throw new Error(`No sign-in saved for ${server.name}; add it again`);
    const info = await fetchInfo(server.baseUrl, token);
    versionMismatch =
      info.version === deps.localVersion
        ? null
        : { local: deps.localVersion, remote: info.version };

    const headers = { origin: server.baseUrl, cookie: `${COOKIE}=${token}` };
    const wsBase = server.baseUrl.replace(/^http/, 'ws');
    const transport = reconnectingTransport(
      async () => webSocketTransport(await openSocket(`${wsBase}/wire`, headers)),
      { backoffMs: [500, 1000, 2000, 5000] }
    );
    // No deadline on this hop: the renderer's own call deadlines already apply end to end.
    const wire = connect(transport, { callTimeoutMs: 0 });
    try {
      await withTimeout(transport.ready(), CONNECT_TIMEOUT_MS, `${server.name} did not answer`);
    } catch (cause) {
      transport.close();
      throw cause;
    }
    transport.onDisconnect(() => {
      if (active?.transport === transport) connection = 'reconnecting';
    });
    transport.onReconnect(() => {
      if (active?.transport === transport) connection = 'connected';
    });
    transport.onTerminalFailure((cause) => {
      if (active?.transport !== transport) return;
      connection = 'failed';
      error = errorMessage(cause);
    });

    const proxy = await startBrowserProxy(async (host, port) => {
      const socket = await openSocket(
        `${wsBase}/tunnel?host=${encodeURIComponent(host)}&port=${port}`,
        headers
      );
      return createWebSocketStream(socket as unknown as WebSocket) as Duplex;
    });
    return { server, transport, connection: wire, proxy };
  };

  const remoteControllers = (wire: Connection): Record<string, Controller> => {
    const remote = client(desktopWireContract, wire) as unknown as Record<string, never>;
    const controllers: Record<string, Controller> = {};
    for (const [domain, contract] of Object.entries(desktopDomainContracts)) {
      if (LOCAL_ONLY_DOMAINS.has(domain)) continue;
      controllers[domain] = forwardController(contract as never, remote[domain]);
    }
    return controllers;
  };

  /** Points routing and the browser at `next` (null: this computer). */
  const activate = async (next: ActiveRemote | null): Promise<void> => {
    const previous = active;
    active = next;
    deps.setRouting(Promise.resolve(next ? remoteControllers(next.connection) : null));
    await deps.setBrowserProxyPort(next ? next.proxy.port : null);
    connection = next ? 'connected' : 'local';
    if (previous && previous !== next) {
      previous.transport.close();
      await previous.proxy.close();
    }
  };

  return {
    start() {
      // Hold renderer traffic (synchronously, before any await) until the choice is
      // known, so nothing lands on the wrong computer during startup.
      let settle!: (controllers: Record<string, Controller> | null) => void;
      deps.setRouting(new Promise((resolve) => (settle = resolve)));
      return serialize(async () => {
        let stored = await load();
        const seed = deps.windowServer;
        if (seed) {
          // A window opened for this computer: remember it here and drive it from the start.
          await deps.secrets.write(seed.server.id, seed.token);
          stored = {
            activeServerId: seed.server.id,
            servers: [
              ...stored.servers.filter((entry) => entry.id !== seed.server.id),
              seed.server,
            ],
          };
          await save(stored);
        }
        const server = stored.servers.find((entry) => entry.id === stored.activeServerId);
        if (!server) {
          settle(null);
          return;
        }
        connection = 'connecting';
        try {
          const remote = await open(server);
          active = remote;
          settle(remoteControllers(remote.connection));
          await deps.setBrowserProxyPort(remote.proxy.port);
          connection = 'connected';
          error = null;
          deps.setWindowTitle?.(server.name);
        } catch (cause) {
          settle(null);
          connection = 'local';
          error = `Couldn't reach ${server.name} (${errorMessage(cause)}); using this computer`;
          deps.warn?.('remote client: startup connection failed', {
            server: server.baseUrl,
            error,
          });
          await save({ ...stored, activeServerId: null });
        }
      });
    },
    async state(): Promise<RemoteClientState> {
      const stored = await load();
      return {
        activeServerId: active?.server.id ?? null,
        servers: stored.servers,
        connection,
        error,
        versionMismatch: active ? versionMismatch : null,
        windowServerId: deps.windowServer?.server.id ?? null,
      };
    },
    addServer: ({ link, name }) =>
      serialize(async () => {
        const { baseUrl, token } = parseLink(link);
        const info = await fetchInfo(baseUrl, token);
        const stored = await load();
        const existing = stored.servers.find((entry) => entry.baseUrl === baseUrl);
        const server: RemoteServer = {
          id: existing?.id ?? randomUUID(),
          name: name?.trim() || info.name,
          baseUrl,
        };
        await deps.secrets.write(server.id, token);
        await save({
          ...stored,
          servers: [...stored.servers.filter((entry) => entry.id !== server.id), server],
        });
        return server;
      }),
    removeServer: (id) =>
      serialize(async () => {
        if (active?.server.id === id) {
          await activate(null);
          deps.reloadWindow();
        }
        const stored = await load();
        await deps.secrets.remove(id);
        await save({
          activeServerId: stored.activeServerId === id ? null : stored.activeServerId,
          servers: stored.servers.filter((entry) => entry.id !== id),
        });
      }),
    switchTo: (serverId) =>
      serialize(async () => {
        const stored = await load();
        if ((active?.server.id ?? null) === serverId) return;
        if (serverId === null) {
          await activate(null);
        } else {
          const server = stored.servers.find((entry) => entry.id === serverId);
          if (!server) throw new Error('That computer is no longer saved');
          connection = 'connecting';
          try {
            await activate(await open(server));
            error = null;
          } catch (cause) {
            connection = active ? 'connected' : 'local';
            throw new Error(`Couldn't reach ${server.name}: ${errorMessage(cause)}`);
          }
        }
        await save({ ...stored, activeServerId: serverId });
        deps.setWindowTitle?.(active?.server.name ?? null);
        deps.reloadWindow();
      }),
    openWindow: async (serverId) => {
      if (!deps.launchWindow) throw new Error('This app cannot open another window');
      if (serverId === null) {
        await deps.launchWindow(null);
        return;
      }
      const server = (await load()).servers.find((entry) => entry.id === serverId);
      if (!server) throw new Error('That computer is no longer saved');
      const token = await deps.secrets.read(server.id);
      if (!token) throw new Error(`No sign-in saved for ${server.name}; add it again`);
      await deps.launchWindow({ server, token });
    },
    dispose: () => serialize(disconnect),
  };
}

/** `http://host:port/connect?token=…` → base URL and token. */
export function parseLink(link: string): { baseUrl: string; token: string } {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error(
      'That is not a link; copy it from Settings → Remote access on the other computer'
    );
  }
  const token = url.searchParams.get('token');
  if (url.protocol !== 'http:' || url.pathname !== '/connect' || !token) {
    throw new Error('Copy the link from Settings → Remote access on the other computer');
  }
  return { baseUrl: url.origin, token };
}

async function fetchInfo(baseUrl: string, token: string): Promise<RemoteServerInfo> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/info`, {
      headers: { cookie: `${COOKIE}=${token}` },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`${new URL(baseUrl).host} is not reachable (${errorMessage(cause)})`);
  }
  if (response.status === 401) throw new Error('The link is no longer valid; copy a new one');
  if (!response.ok) throw new Error(`The other computer answered ${response.status}`);
  return (await response.json()) as RemoteServerInfo;
}

function openSocket(url: string, headers: Record<string, string>): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, maxPayload: 64 * 1024 * 1024 });
    socket.once('open', () => resolve(socket as unknown as WebSocketLike));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) =>
      reject(new Error(`The other computer refused the connection (${response.statusCode})`))
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    );
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
