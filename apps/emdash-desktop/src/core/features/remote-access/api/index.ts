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
