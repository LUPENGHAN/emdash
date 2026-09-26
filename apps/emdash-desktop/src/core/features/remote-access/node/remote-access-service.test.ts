import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_REMOTE_ACCESS_SETTINGS, type RemoteAccessSettings } from '../api';
import { createRemoteAccessService, type RemoteAccessServer } from './remote-access-service';

function setup(initial: Partial<RemoteAccessSettings> = {}) {
  let settings: RemoteAccessSettings = { ...DEFAULT_REMOTE_ACCESS_SETTINGS, ...initial };
  let stored: string | null = null;
  const listeners = new Set<() => void>();
  const timers: (() => void)[] = [];
  const server = {
    start: vi.fn<RemoteAccessServer['start']>(async () => {}),
    stop: vi.fn<RemoteAccessServer['stop']>(async () => {}),
    clientCount: () => 2,
  };
  const service = createRemoteAccessService({
    getSettings: async () => settings,
    onSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readToken: async () => stored,
    writeToken: async (token) => {
      stored = token;
    },
    server,
    listAddresses: () => [
      { name: 'This computer only', address: '127.0.0.1' },
      { name: 'ZeroTier (feth1)', address: '10.147.17.5' },
      { name: 'en0', address: '192.168.1.8' },
    ],
    setTimer: (callback) => {
      timers.push(callback);
      return () => timers.splice(timers.indexOf(callback), 1);
    },
  });
  const change = async (next: Partial<RemoteAccessSettings>) => {
    settings = { ...settings, ...next };
    for (const listener of listeners) listener();
    await service.status();
  };
  return { service, server, change, timers, token: () => stored };
}

describe('createRemoteAccessService', () => {
  it('stays off until enabled, then listens with a generated token', async () => {
    const { service, server, change, token } = setup();
    await service.apply();
    expect(server.start).not.toHaveBeenCalled();
    expect(await service.links()).toEqual([]);

    await change({ enabled: true, host: '10.147.17.5', port: 7788 });

    expect(token()).toMatch(/^[\w-]{40,}$/);
    expect(server.start).toHaveBeenCalledWith({ host: '10.147.17.5', port: 7788, token: token() });
    expect(await service.status()).toMatchObject({
      state: 'listening',
      url: 'http://10.147.17.5:7788',
      clients: 2,
    });
    expect(await service.links()).toEqual([
      { name: 'ZeroTier (feth1)', url: `http://10.147.17.5:7788/connect?token=${token()}` },
    ]);
  });

  it('restarts on address changes and stops when disabled', async () => {
    const { service, server, change } = setup({ enabled: true });
    await service.apply();
    await change({ port: 9000 });
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(server.start).toHaveBeenLastCalledWith(expect.objectContaining({ port: 9000 }));

    await change({ enabled: false });
    expect(server.stop).toHaveBeenCalledTimes(2);
    expect((await service.status()).state).toBe('off');
  });

  it('a new token replaces the old one and restarts the server', async () => {
    const { service, server, token } = setup({ enabled: true });
    await service.apply();
    const first = token();

    await service.regenerateToken();

    expect(token()).not.toBe(first);
    expect(server.start).toHaveBeenLastCalledWith(expect.objectContaining({ token: token() }));
  });

  it('reports a server that cannot start and retries until the address exists', async () => {
    const { service, server, timers } = setup({ enabled: true, host: '10.147.17.5' });
    server.start.mockRejectedValueOnce(new Error('listen EADDRNOTAVAIL'));
    await service.apply();
    expect(await service.status()).toMatchObject({ state: 'error', error: 'listen EADDRNOTAVAIL' });
    expect(await service.links()).toEqual([]);
    expect(timers).toHaveLength(1);

    // ZeroTier came up: the retry succeeds and no further retry is scheduled.
    timers[0]!();
    expect((await service.status()).state).toBe('listening');
    expect(server.start).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(0);
  });

  it('on all addresses, offers a link per network with loopback last', async () => {
    const { service, token } = setup({ enabled: true, host: '0.0.0.0' });
    await service.apply();
    expect((await service.links()).map((link) => [link.name, link.url])).toEqual([
      ['ZeroTier (feth1)', `http://10.147.17.5:7788/connect?token=${token()}`],
      ['en0', `http://192.168.1.8:7788/connect?token=${token()}`],
      ['This computer only', `http://127.0.0.1:7788/connect?token=${token()}`],
    ]);
  });
});
