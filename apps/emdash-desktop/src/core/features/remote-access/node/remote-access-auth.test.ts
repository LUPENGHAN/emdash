import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteAccessAuth,
  hashAccessKey,
  LOCKOUT_MS,
  MAX_FAILURES_PER_ADDRESS,
  verifyAccessKey,
} from './remote-access-auth';

describe('createRemoteAccessAuth', () => {
  let dir: string;
  let keyHash: string | null;
  let now: number;
  const make = (onDevicePaired = vi.fn()) =>
    createRemoteAccessAuth({
      file: path.join(dir, 'devices.json'),
      readKeyHash: async () => keyHash,
      writeKeyHash: async (hash) => {
        keyHash = hash;
      },
      onDevicePaired,
      now: () => now,
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'emdash-auth-'));
    keyHash = null;
    now = Date.parse('2026-10-06T08:00:00Z');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps devices across restarts, storing only token hashes', async () => {
    const paired = vi.fn();
    const auth = make(paired);
    const { token, device } = await auth.issue({
      clientId: 'phone',
      name: 'Pixel',
      address: '10.0.0.2',
    });
    expect(paired).toHaveBeenCalledTimes(1);
    // Signing in again from the same install is not news.
    await auth.issue({ clientId: 'phone', name: 'Pixel', address: '10.0.0.2' });
    expect(paired).toHaveBeenCalledTimes(1);

    const file = await readFile(path.join(dir, 'devices.json'), 'utf8');
    expect(file).not.toContain(token);

    const restarted = make();
    expect(await restarted.identify(token)).toBeNull(); // replaced by the second sign-in
    const { token: latest } = await restarted.issue({
      clientId: 'phone',
      name: 'Pixel 9',
      address: '10.0.0.3',
    });
    expect(await make().identify(latest)).toMatchObject({ id: device.id, name: 'Pixel 9' });
    expect(await restarted.identify('made-up')).toBeNull();
  });

  it('tells listeners which devices were signed out', async () => {
    const auth = make();
    const a = await auth.issue({ clientId: null, name: 'A', address: 'x' });
    const b = await auth.issue({ clientId: null, name: 'B', address: 'x' });
    const revoked = vi.fn();
    auth.onRevoked(revoked);
    await auth.revoke(a.device.id);
    expect(revoked).toHaveBeenLastCalledWith([a.device.id]);
    expect(await auth.identify(a.token)).toBeNull();
    await auth.revokeAll();
    expect(revoked).toHaveBeenLastCalledWith([b.device.id]);
    expect(await auth.devices()).toEqual([]);
  });

  it('locks an address out after wrong keys, until the lockout ends', async () => {
    const auth = make();
    await auth.setAccessKey('correct horse battery');
    expect(keyHash).toMatch(/^scrypt\$/);
    expect(keyHash).not.toContain('correct');

    for (let i = 1; i < MAX_FAILURES_PER_ADDRESS; i++) {
      expect(await auth.checkAccessKey('nope nope nope', '1.2.3.4')).toEqual({
        result: 'wrong',
        remaining: MAX_FAILURES_PER_ADDRESS - i,
      });
    }
    expect((await auth.checkAccessKey('nope nope nope', '1.2.3.4')).result).toBe('locked');
    expect((await auth.checkAccessKey('correct horse battery', '1.2.3.4')).result).toBe('locked');
    expect((await auth.checkAccessKey('correct horse battery', '5.6.7.8')).result).toBe('ok');

    now += LOCKOUT_MS + 1;
    expect((await auth.checkAccessKey('correct horse battery', '1.2.3.4')).result).toBe('ok');

    await auth.setAccessKey(null);
    expect((await auth.checkAccessKey('correct horse battery', '1.2.3.4')).result).toBe('off');
  });
});

describe('access key hashing', () => {
  it('verifies the key it hashed and nothing else', async () => {
    const hash = await hashAccessKey('一把足够长的访问密钥');
    expect(await verifyAccessKey('一把足够长的访问密钥', hash)).toBe(true);
    expect(await verifyAccessKey('一把足够长的访问密钥 ', hash)).toBe(false);
    expect(await verifyAccessKey('anything', 'not-a-hash')).toBe(false);
    // Salted: the same key hashes differently each time.
    expect(await hashAccessKey('一把足够长的访问密钥')).not.toBe(hash);
  });
});
