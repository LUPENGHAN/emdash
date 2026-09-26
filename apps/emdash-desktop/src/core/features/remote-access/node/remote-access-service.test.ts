import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_REMOTE_ACCESS_SETTINGS, type RemoteAccessSettings } from '../api';
import { createRemoteAccessService, type RemoteAccessServer } from './remote-access-service';

function setup(initial: Partial<RemoteAccessSettings> = {}) {
  let settings: RemoteAccessSettings = { ...DEFAULT_REMOTE_ACCESS_SETTINGS, ...initial };
  let stored: string | null = null;
  const listeners = new Set<() => void>();
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
    listAddresses: () => [{ name: 'This computer only', address: '127.0.0.1' }],
  });
  const change = async (next: Partial<RemoteAccessSettings>) => {
    settings = { ...settings, ...next };
    for (const listener of listeners) listener();
    await service.status();
  };
  return { service, server, change, token: () => stored };
}

describe('createRemoteAccessService', () => {
  it('stays off until enabled, then listens with a generated token', async () => {
    const { service, server, change, token } = setup();
    await service.apply();
    expect(server.start).not.toHaveBeenCalled();
    expect(await service.link()).toBeNull();

    await change({ enabled: true, host: '10.147.17.5', port: 7788 });

    expect(token()).toMatch(/^[\w-]{40,}$/);
    expect(server.start).toHaveBeenCalledWith({ host: '10.147.17.5', port: 7788, token: token() });
    expect(await service.status()).toMatchObject({
      state: 'listening',
      url: 'http://10.147.17.5:7788',
      clients: 2,
    });
    expect(await service.link()).toBe(`http://10.147.17.5:7788/connect?token=${token()}`);
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

  it('reports a server that cannot start', async () => {
    const { service, server } = setup({ enabled: true });
    server.start.mockRejectedValueOnce(new Error('listen EADDRINUSE'));
    await service.apply();
    expect(await service.status()).toMatchObject({ state: 'error', error: 'listen EADDRINUSE' });
    expect(await service.link()).toBeNull();
  });
});
