import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteAccessDevice } from '../api';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** Access keys are chosen by people: at least this long, hashed slowly (scrypt). */
export const MIN_ACCESS_KEY_LENGTH = 12;
const MAX_ACCESS_KEY_LENGTH = 256;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** Wrong attempts from one address before it waits, and for how long. */
export const MAX_FAILURES_PER_ADDRESS = 5;
/** Wrong access keys from everywhere together before key sign-in pauses for everyone. */
export const MAX_KEY_FAILURES_OVERALL = 30;
export const LOCKOUT_MS = 15 * 60_000;
/** Last-seen times are written at most this often. */
const TOUCH_PERSIST_MS = 60_000;

type StoredDevice = RemoteAccessDevice & { tokenHash: string };
type Store = { version: 1; devices: StoredDevice[] };

export type AccessKeyCheck =
  | { result: 'ok' }
  | { result: 'wrong'; remaining: number }
  | { result: 'locked'; retryAfterMs: number }
  | { result: 'off' };

export type RemoteAccessAuthDeps = {
  /** JSON file holding the signed-in devices (token hashes, never tokens). */
  file: string;
  /** The access key's hash (`scrypt$…`), kept with the app's other secrets. */
  readKeyHash: () => Promise<string | null>;
  writeKeyHash: (hash: string | null) => Promise<void>;
  /** A device signed in for the first time: worth telling the person at the computer. */
  onDevicePaired?: (device: RemoteAccessDevice) => void;
  now?: () => number;
};

export type RemoteAccessAuth = ReturnType<typeof createRemoteAccessAuth>;

/**
 * Who may use remote access, beyond the computer's link: devices each get a token of
 * their own when they sign in (with the link or the access key), so one can be signed
 * out alone; the access key — one the person picks, the same on all their computers —
 * pairs a device without the link. Wrong attempts lock an address out for a while, and
 * too many wrong keys from everywhere pause key sign-in altogether.
 */
export function createRemoteAccessAuth(deps: RemoteAccessAuthDeps) {
  const now = deps.now ?? Date.now;
  let devices: StoredDevice[] = [];
  let keyHash: string | null = null;
  let loaded: Promise<void> | null = null;
  let persistTimer: NodeJS.Timeout | null = null;
  const revokedListeners = new Set<(ids: string[]) => void>();
  const failures = new Map<string, { count: number; lockedUntil: number }>();
  let keyFailures: number[] = [];
  let keyPausedUntil = 0;

  const load = (): Promise<void> => {
    loaded ??= (async () => {
      try {
        const store = JSON.parse(await readFile(deps.file, 'utf8')) as Partial<Store>;
        devices = Array.isArray(store.devices) ? store.devices : [];
      } catch {
        devices = [];
      }
      keyHash = await deps.readKeyHash();
    })();
    return loaded;
  };

  const persist = async (): Promise<void> => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const store: Store = { version: 1, devices };
    await mkdir(path.dirname(deps.file), { recursive: true });
    const temp = `${deps.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, deps.file);
  };

  const persistSoon = (): void => {
    persistTimer ??= setTimeout(() => void persist().catch(() => undefined), TOUCH_PERSIST_MS);
    persistTimer.unref?.();
  };

  const publicDevice = ({ tokenHash: _tokenHash, ...device }: StoredDevice): RemoteAccessDevice =>
    device;

  const notifyRevoked = (ids: string[]): void => {
    if (ids.length === 0) return;
    for (const listener of revokedListeners) listener(ids);
  };

  const lockedFor = (address: string): number => {
    const entry = failures.get(address);
    return entry && entry.lockedUntil > now() ? entry.lockedUntil - now() : 0;
  };

  /** Counts a wrong attempt; returns how many are left before the address waits. */
  const fail = (address: string): number => {
    const entry = failures.get(address) ?? { count: 0, lockedUntil: 0 };
    if (entry.lockedUntil && entry.lockedUntil <= now()) entry.count = 0;
    entry.count += 1;
    if (entry.count >= MAX_FAILURES_PER_ADDRESS) entry.lockedUntil = now() + LOCKOUT_MS;
    failures.set(address, entry);
    return Math.max(0, MAX_FAILURES_PER_ADDRESS - entry.count);
  };

  return {
    load,

    /** The device a token (a cookie, or a token the app saved) belongs to; null if none. */
    async identify(token: string | null): Promise<RemoteAccessDevice | null> {
      if (!token) return null;
      await load();
      const hash = sha256(token);
      const device = devices.find((entry) => safeEqual(entry.tokenHash, hash));
      return device ? publicDevice(device) : null;
    },

    /** Notes that a signed-in device was just used, and from where. */
    async touch(id: string, address: string): Promise<void> {
      await load();
      const device = devices.find((entry) => entry.id === id);
      if (!device) return;
      device.lastSeenAt = new Date(now()).toISOString();
      device.lastAddress = address;
      persistSoon();
    },

    /**
     * Signs a device in: a fresh token of its own. A device the app identifies (its
     * install's `clientId`) keeps one entry however often it signs in again.
     */
    async issue(input: {
      clientId: string | null;
      name: string;
      address: string;
    }): Promise<{ token: string; device: RemoteAccessDevice }> {
      await load();
      const token = randomBytes(32).toString('base64url');
      const at = new Date(now()).toISOString();
      const existing = input.clientId
        ? devices.find((entry) => entry.clientId === input.clientId)
        : undefined;
      let device: StoredDevice;
      if (existing) {
        existing.tokenHash = sha256(token);
        existing.name = input.name;
        existing.lastSeenAt = at;
        existing.lastAddress = input.address;
        device = existing;
      } else {
        device = {
          id: randomUUID(),
          clientId: input.clientId,
          name: input.name,
          createdAt: at,
          lastSeenAt: at,
          lastAddress: input.address,
          tokenHash: sha256(token),
        };
        devices.push(device);
      }
      await persist();
      if (!existing) deps.onDevicePaired?.(publicDevice(device));
      return { token, device: publicDevice(device) };
    },

    async devices(): Promise<RemoteAccessDevice[]> {
      await load();
      return devices.map(publicDevice).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    },

    async revoke(id: string): Promise<boolean> {
      await load();
      const before = devices.length;
      devices = devices.filter((entry) => entry.id !== id);
      if (devices.length === before) return false;
      await persist();
      notifyRevoked([id]);
      return true;
    },

    async revokeAll(): Promise<void> {
      await load();
      const ids = devices.map((entry) => entry.id);
      devices = [];
      await persist();
      notifyRevoked(ids);
    },

    onRevoked(listener: (ids: string[]) => void): () => void {
      revokedListeners.add(listener);
      return () => revokedListeners.delete(listener);
    },

    async hasAccessKey(): Promise<boolean> {
      await load();
      return keyHash !== null;
    },

    /** Sets the access key (null: key sign-in off). Devices already signed in stay. */
    async setAccessKey(key: string | null): Promise<void> {
      await load();
      if (key !== null) {
        if (key.length < MIN_ACCESS_KEY_LENGTH) {
          throw new Error(`The access key needs at least ${MIN_ACCESS_KEY_LENGTH} characters`);
        }
        if (key.length > MAX_ACCESS_KEY_LENGTH) throw new Error('The access key is too long');
      }
      keyHash = key === null ? null : await hashAccessKey(key);
      await deps.writeKeyHash(keyHash);
    },

    /** Checks an access key from an address, counting wrong ones toward its lockout. */
    async checkAccessKey(key: string, address: string): Promise<AccessKeyCheck> {
      await load();
      if (!keyHash) return { result: 'off' };
      const wait = Math.max(lockedFor(address), keyPausedUntil - now());
      if (wait > 0) return { result: 'locked', retryAfterMs: wait };
      if (await verifyAccessKey(key, keyHash)) {
        failures.delete(address);
        return { result: 'ok' };
      }
      keyFailures = [...keyFailures.filter((at) => at > now() - LOCKOUT_MS), now()];
      if (keyFailures.length >= MAX_KEY_FAILURES_OVERALL) keyPausedUntil = now() + LOCKOUT_MS;
      const remaining = fail(address);
      return remaining === 0
        ? { result: 'locked', retryAfterMs: LOCKOUT_MS }
        : { result: 'wrong', remaining };
    },

    /** A wrong link or device token: counts toward the address's lockout too. */
    failToken(address: string): void {
      fail(address);
    },

    /** How long an address must wait before trying again (0: it may). */
    lockedFor,

    /** Writes pending last-seen times. */
    flush: () => (persistTimer ? persist() : Promise.resolve()),
  };
}

export async function hashAccessKey(key: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(key.normalize('NFC'), salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyAccessKey(key: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(
    key.normalize('NFC'),
    Buffer.from(salt, 'base64'),
    expected.length,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    }
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
