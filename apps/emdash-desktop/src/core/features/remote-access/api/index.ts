import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Browser access to this Emdash: an HTTP server on a chosen local address serves the
 * renderer and carries the wire over a WebSocket, so a browser on another computer
 * (e.g. over ZeroTier) drives this machine's projects, agents and code.
 */
export const remoteAccessSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The local address to listen on, or ALL_ADDRESSES; loopback by default. */
  host: z.string().min(1),
  port: z.number().int().min(1024).max(65_535),
});

export type RemoteAccessSettings = z.infer<typeof remoteAccessSettingsSchema>;

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 7788,
};

/** Listen on every interface (every network this computer is on). */
export const ALL_ADDRESSES = '0.0.0.0';

export type RemoteAccessAddress = { name: string; address: string };

/** A sign-in link for one of the addresses browsers can reach. */
export type RemoteAccessLink = { name: string; url: string };

export type RemoteAccessStatus = {
  state: 'off' | 'listening' | 'error';
  /** Where it listens, e.g. `http://10.147.17.5:7788` or `http://0.0.0.0:7788`. */
  url: string | null;
  error: string | null;
  /** Local IPv4 addresses to listen on, loopback first. */
  addresses: RemoteAccessAddress[];
  /** Browsers currently connected. */
  clients: number;
};

export interface RemoteAccessService {
  status(): Promise<RemoteAccessStatus>;
  /** Links that sign a browser in, one per reachable address; empty while access is off. */
  links(): Promise<RemoteAccessLink[]>;
  /** Invalidates the current link and disconnects every browser. */
  regenerateToken(): Promise<void>;
}

export const remoteAccessDomain = 'remoteAccess' as const;

const voidInput = z.void();

export const remoteAccessContract = defineContract({
  status: procedure({ input: voidInput, output: z.custom<RemoteAccessStatus>() }),
  links: procedure({ input: voidInput, output: z.custom<RemoteAccessLink[]>() }),
  regenerateToken: procedure({ input: voidInput, output: z.void() }),
});

// ── Client side: this app driving another computer's Emdash ────────────────────────

/** What a serving Emdash reports about itself at `/info`. */
export type RemoteServerInfo = { name: string; version: string };

/** A computer this app can switch to; its token stays in the encrypted secrets store. */
export type RemoteServer = {
  id: string;
  name: string;
  /** e.g. `http://10.147.17.5:7788` */
  baseUrl: string;
};

export type RemoteClientState = {
  /** The computer this window drives: null for this one. */
  activeServerId: string | null;
  servers: RemoteServer[];
  connection: 'local' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  /** Why the last connect or switch failed, e.g. an unreachable address. */
  error: string | null;
  /** Set when the other computer runs a different Emdash build. */
  versionMismatch: { local: string; remote: string } | null;
  /**
   * The computer this window was opened for ("open in new window"), or null for the
   * main window. Such a window has its own profile, so "this computer" is the main one.
   */
  windowServerId: string | null;
};

export interface RemoteClientService {
  state(): Promise<RemoteClientState>;
  /** Checks the link against the other computer, then saves it. */
  addServer(input: { link: string; name?: string }): Promise<RemoteServer>;
  removeServer(id: string): Promise<void>;
  /** Drives the given computer (null: this one) and reloads the window. */
  switchTo(serverId: string | null): Promise<void>;
  /**
   * Opens another window on the given computer: an app instance with that computer's own
   * profile, connected to it. Null brings up the main window (this computer).
   */
  openWindow(serverId: string | null): Promise<void>;
}

export const remoteClientDomain = 'remoteClient' as const;

export const remoteClientContract = defineContract({
  state: procedure({ input: voidInput, output: z.custom<RemoteClientState>() }),
  addServer: procedure({
    input: z.object({ link: z.string().min(1), name: z.string().optional() }),
    output: z.custom<RemoteServer>(),
  }),
  removeServer: procedure({ input: z.object({ id: z.string() }), output: z.void() }),
  switchTo: procedure({ input: z.object({ serverId: z.string().nullable() }), output: z.void() }),
  openWindow: procedure({
    input: z.object({ serverId: z.string().nullable() }),
    output: z.void(),
  }),
});

/**
 * Domains this window keeps on its own computer while driving another: the OS shell
 * (links, clipboard, dialogs, window), the built-in browser, app updates and logs, and
 * the switch itself. Everything else is the other computer's.
 */
export const LOCAL_ONLY_DOMAINS: ReadonlySet<string> = new Set([
  'host',
  'browser',
  'logging',
  'updates',
  'devPerf',
  'telemetry',
  remoteClientDomain,
]);
