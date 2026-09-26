import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type {
  RemoteAccessAddress,
  RemoteAccessService,
  RemoteAccessSettings,
  RemoteAccessStatus,
} from '../api';

/** The HTTP + WebSocket server the service drives; lives in the desktop main process. */
export type RemoteAccessServer = {
  start(options: { host: string; port: number; token: string }): Promise<void>;
  stop(): Promise<void>;
  clientCount(): number;
};

export type RemoteAccessServiceDeps = {
  getSettings: () => Promise<RemoteAccessSettings>;
  onSettingsChanged: (listener: () => void) => () => void;
  readToken: () => Promise<string | null>;
  writeToken: (token: string) => Promise<void>;
  server: RemoteAccessServer;
  listAddresses?: () => RemoteAccessAddress[];
  warn?: (message: string, details: Record<string, unknown>) => void;
};

export type ManagedRemoteAccessService = RemoteAccessService & {
  /** Starts, restarts or stops the server to match the settings. */
  apply(): Promise<void>;
  dispose(): Promise<void>;
};

export function createRemoteAccessService(
  deps: RemoteAccessServiceDeps
): ManagedRemoteAccessService {
  const listAddresses = deps.listAddresses ?? localIpv4Addresses;
  let running: { host: string; port: number; token: string } | null = null;
  let error: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  // Settings changes and token rotation run one at a time, in order.
  const serialize = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work, work);
    return queue;
  };

  const token = async (): Promise<string> => {
    const existing = await deps.readToken();
    if (existing) return existing;
    const created = randomBytes(32).toString('base64url');
    await deps.writeToken(created);
    return created;
  };

  const reconcile = async (): Promise<void> => {
    const settings = await deps.getSettings();
    if (!settings.enabled) {
      if (running) await deps.server.stop();
      running = null;
      error = null;
      return;
    }
    const wanted = { host: settings.host, port: settings.port, token: await token() };
    if (
      running &&
      running.host === wanted.host &&
      running.port === wanted.port &&
      running.token === wanted.token
    ) {
      return;
    }
    if (running) await deps.server.stop();
    running = null;
    try {
      await deps.server.start(wanted);
      running = wanted;
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      deps.warn?.('remote access: could not start the server', {
        host: wanted.host,
        port: wanted.port,
        error,
      });
    }
  };

  const unsubscribe = deps.onSettingsChanged(() => void serialize(reconcile));

  return {
    apply: () => serialize(reconcile),
    async status(): Promise<RemoteAccessStatus> {
      await queue;
      const settings = await deps.getSettings();
      return {
        state: running ? 'listening' : settings.enabled && error ? 'error' : 'off',
        url: running ? baseUrl(running) : null,
        error: settings.enabled ? error : null,
        addresses: listAddresses(),
        clients: running ? deps.server.clientCount() : 0,
      };
    },
    async link(): Promise<string | null> {
      await queue;
      return running ? `${baseUrl(running)}/connect?token=${running.token}` : null;
    },
    regenerateToken: () =>
      serialize(async () => {
        await deps.writeToken(randomBytes(32).toString('base64url'));
        await reconcile();
      }),
    async dispose(): Promise<void> {
      unsubscribe();
      await serialize(async () => {
        if (running) await deps.server.stop();
        running = null;
      });
    },
  };
}

function baseUrl({ host, port }: { host: string; port: number }): string {
  return `http://${host}:${port}`;
}

/** Loopback first, then each interface's IPv4 address (ZeroTier ones named as such). */
export function localIpv4Addresses(): RemoteAccessAddress[] {
  const found: RemoteAccessAddress[] = [{ name: 'This computer only', address: '127.0.0.1' }];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const zeroTier = name.startsWith('feth') || name.startsWith('zt');
      found.push({ name: zeroTier ? `ZeroTier (${name})` : name, address: entry.address });
    }
  }
  return found;
}
