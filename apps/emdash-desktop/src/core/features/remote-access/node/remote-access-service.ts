import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import {
  ALL_ADDRESSES,
  type RemoteAccessAddress,
  type RemoteAccessLink,
  type RemoteAccessService,
  type RemoteAccessSettings,
  type RemoteAccessStatus,
} from '../api';

/** A private-network address may come up after Emdash (ZeroTier at login): keep trying. */
export const START_RETRY_MS = 30_000;

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
  setTimer?: (callback: () => void, ms: number) => () => void;
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
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  let cancelRetry: (() => void) | null = null;
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
    cancelRetry?.();
    cancelRetry = null;
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
      cancelRetry = setTimer(() => void serialize(reconcile), START_RETRY_MS);
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
    async links(): Promise<RemoteAccessLink[]> {
      await queue;
      if (!running) return [];
      const { port, token } = running;
      // Every network's address, loopback (this computer only) last.
      const hosts =
        running.host === ALL_ADDRESSES
          ? [...listAddresses()].sort(
              (a, b) => Number(a.address === '127.0.0.1') - Number(b.address === '127.0.0.1')
            )
          : [
              listAddresses().find((entry) => entry.address === running!.host) ?? {
                name: running.host,
                address: running.host,
              },
            ];
      return hosts.map((entry) => ({
        name: entry.name,
        url: `${baseUrl({ host: entry.address, port })}/connect?token=${token}`,
      }));
    },
    regenerateToken: () =>
      serialize(async () => {
        await deps.writeToken(randomBytes(32).toString('base64url'));
        await reconcile();
      }),
    async dispose(): Promise<void> {
      unsubscribe();
      cancelRetry?.();
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
