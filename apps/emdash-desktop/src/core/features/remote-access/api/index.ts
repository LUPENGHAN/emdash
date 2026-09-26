import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Browser access to this Emdash: an HTTP server on a chosen local address serves the
 * renderer and carries the wire over a WebSocket, so a browser on another computer
 * (e.g. over ZeroTier) drives this machine's projects, agents and code.
 */
export const remoteAccessSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The local address to listen on; never all interfaces by default. */
  host: z.string().min(1),
  port: z.number().int().min(1024).max(65_535),
});

export type RemoteAccessSettings = z.infer<typeof remoteAccessSettingsSchema>;

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 7788,
};

export type RemoteAccessAddress = { name: string; address: string };

export type RemoteAccessStatus = {
  state: 'off' | 'listening' | 'error';
  /** The address browsers open, without the access token. */
  url: string | null;
  error: string | null;
  /** Local IPv4 addresses to listen on, loopback first. */
  addresses: RemoteAccessAddress[];
  /** Browsers currently connected. */
  clients: number;
};

export interface RemoteAccessService {
  status(): Promise<RemoteAccessStatus>;
  /** The link that signs a browser in; null while access is off. */
  link(): Promise<string | null>;
  /** Invalidates the current link and disconnects every browser. */
  regenerateToken(): Promise<void>;
}

export const remoteAccessDomain = 'remoteAccess' as const;

const voidInput = z.void();

export const remoteAccessContract = defineContract({
  status: procedure({ input: voidInput, output: z.custom<RemoteAccessStatus>() }),
  link: procedure({ input: voidInput, output: z.string().nullable() }),
  regenerateToken: procedure({ input: voidInput, output: z.void() }),
});
