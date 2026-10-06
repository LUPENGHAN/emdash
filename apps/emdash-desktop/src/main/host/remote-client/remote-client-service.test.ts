import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWireSessionHub, type Controller } from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteAccessStatus } from '@core/features/remote-access/api';
import { createRemoteAccessAuth } from '@core/features/remote-access/node/remote-access-auth';
import { createRemoteAccessWireController } from '@core/features/remote-access/node/wire-controller';
import { createRemoteAccessServer } from '../remote-access-server';
import { createRemoteClientService, parseLink } from './remote-client-service';

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));

const TOKEN = 'server-token';
const SERVER_STATUS: RemoteAccessStatus = {
  state: 'listening',
  url: 'http://127.0.0.1',
  error: null,
  addresses: [],
  clients: 1,
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('createRemoteClientService', () => {
  let dir: string;
  let port: number;
  let server: ReturnType<typeof createRemoteAccessServer>;
  let routing: Promise<Record<string, Controller> | null> | null;
  let secrets: Map<string, string>;
  let reloads: number;
  let proxyPorts: (number | null)[];

  const makeService = (version = '1.2.6') =>
    createRemoteClientService({
      storePath: path.join(dir, 'remote-servers.json'),
      secrets: {
        read: async (id) => secrets.get(id) ?? null,
        write: async (id, token) => void secrets.set(id, token),
        remove: async (id) => void secrets.delete(id),
      },
      localVersion: version,
      setRouting: (next) => {
        routing = next;
      },
      setBrowserProxyPort: async (next) => void proxyPorts.push(next),
      reloadWindow: () => (reloads += 1),
    });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'emdash-remote-client-'));
    await writeFile(path.join(dir, 'index.html'), 'app');
    routing = null;
    secrets = new Map();
    reloads = 0;
    proxyPorts = [];
    // The other computer: its remoteAccess domain answers with SERVER_STATUS.
    const serverController = createRemoteAccessWireController({
      status: async () => SERVER_STATUS,
      links: async () => [],
      regenerateToken: async () => {},
      devices: async () => [],
      revokeDevice: async () => {},
      accessKey: async () => ({ set: false }),
      setAccessKey: async () => {},
    });
    const hub = createWireSessionHub({
      call: (p, input, meta) =>
        serverController.call(p.replace(/^remoteAccess\./, ''), input, meta),
      resolveLive: () => null,
      acquireLive: () => null,
    });
    let session = 0;
    server = createRemoteAccessServer({
      rendererRoot: dir,
      openSession: (transport) => hub.open(++session, transport),
      info: () => ({ name: 'studio-mac', version: '1.2.6' }),
      auth: createRemoteAccessAuth({
        file: path.join(dir, 'devices.json'),
        readKeyHash: async () => null,
        writeKeyHash: async () => {},
      }),
    });
    port = await freePort();
    await server.start({ host: '127.0.0.1', port, token: TOKEN });
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('adds a computer from its link, then drives it', async () => {
    const service = makeService();
    await service.start();
    expect(await routing).toBeNull();

    const added = await service.addServer({
      link: `http://127.0.0.1:${port}/connect?token=${TOKEN}`,
    });
    expect(added).toMatchObject({ name: 'studio-mac', baseUrl: `http://127.0.0.1:${port}` });
    expect(secrets.get(added.id)).toBe(TOKEN);

    await service.switchTo(added.id);
    const controllers = (await routing)!;
    // Local-only domains stay here; the rest answer from the other computer.
    expect(controllers.host).toBeUndefined();
    expect(controllers.browser).toBeUndefined();
    expect(await controllers.remoteAccess!.call('status', undefined)).toEqual(SERVER_STATUS);
    expect(reloads).toBe(1);
    expect(proxyPorts.at(-1)).toEqual(expect.any(Number));
    expect(await service.state()).toMatchObject({
      activeServerId: added.id,
      connection: 'connected',
      versionMismatch: null,
    });

    await service.switchTo(null);
    expect(await routing).toBeNull();
    expect(proxyPorts.at(-1)).toBeNull();
    expect((await service.state()).connection).toBe('local');
    await service.dispose();
  });

  it('opens a computer in a window of its own, and the main window from there', async () => {
    const launched: unknown[] = [];
    const titles: (string | null)[] = [];
    const main = createRemoteClientService({
      storePath: path.join(dir, 'remote-servers.json'),
      secrets: {
        read: async (id) => secrets.get(id) ?? null,
        write: async (id, token) => void secrets.set(id, token),
        remove: async (id) => void secrets.delete(id),
      },
      localVersion: '1.2.6',
      setRouting: (next) => {
        routing = next;
      },
      setBrowserProxyPort: async () => {},
      reloadWindow: () => {},
      launchWindow: async (target) => void launched.push(target),
    });
    await main.start();
    const added = await main.addServer({ link: `http://127.0.0.1:${port}/connect?token=${TOKEN}` });
    await main.openWindow(added.id);
    // The main window stays on this computer; the new one gets the computer and sign-in.
    expect((await main.state()).activeServerId).toBeNull();
    expect(launched).toEqual([{ server: added, token: TOKEN }]);
    await main.dispose();

    // The new window: its own (empty) profile, seeded with that computer, drives it.
    const windowSecrets = new Map<string, string>();
    const window = createRemoteClientService({
      storePath: path.join(dir, 'window', 'remote-servers.json'),
      secrets: {
        read: async (id) => windowSecrets.get(id) ?? null,
        write: async (id, token) => void windowSecrets.set(id, token),
        remove: async (id) => void windowSecrets.delete(id),
      },
      localVersion: '1.2.6',
      setRouting: (next) => {
        routing = next;
      },
      setBrowserProxyPort: async () => {},
      reloadWindow: () => {},
      launchWindow: async (target) => void launched.push(target),
      windowServer: { server: added, token: TOKEN },
      setWindowTitle: (name) => void titles.push(name),
    });
    await window.start();
    expect(await routing).not.toBeNull();
    expect(windowSecrets.get(added.id)).toBe(TOKEN);
    expect(await window.state()).toMatchObject({
      activeServerId: added.id,
      windowServerId: added.id,
      connection: 'connected',
    });
    expect(titles).toEqual(['studio-mac']);
    await window.openWindow(null);
    expect(launched.at(-1)).toBeNull();
    await window.dispose();
  });

  it('reconnects to the saved computer on start and notes a different build', async () => {
    const first = makeService();
    await first.start();
    const added = await first.addServer({
      link: `http://127.0.0.1:${port}/connect?token=${TOKEN}`,
    });
    await first.switchTo(added.id);
    await first.dispose();

    const next = makeService('1.2.7');
    await next.start();
    expect(await routing).not.toBeNull();
    expect((await next.state()).versionMismatch).toEqual({ local: '1.2.7', remote: '1.2.6' });
    await next.dispose();
  });

  it('falls back to this computer when the saved one is unreachable at start', async () => {
    const first = makeService();
    await first.start();
    const added = await first.addServer({
      link: `http://127.0.0.1:${port}/connect?token=${TOKEN}`,
    });
    await first.switchTo(added.id);
    await first.dispose();
    await server.stop();

    const next = makeService();
    await next.start();
    expect(await routing).toBeNull();
    const state = await next.state();
    expect(state).toMatchObject({ activeServerId: null, connection: 'local' });
    expect(state.error).toContain("Couldn't reach studio-mac");
  });

  it('rejects wrong or stale links before saving anything', async () => {
    const service = makeService();
    await expect(service.addServer({ link: 'not a link' })).rejects.toThrow('not a link');
    await expect(
      service.addServer({ link: `http://127.0.0.1:${port}/connect?token=stale` })
    ).rejects.toThrow('no longer valid');
    expect((await service.state()).servers).toEqual([]);
  });
});

describe('parseLink', () => {
  it('splits a Remote access link into base URL and token', () => {
    expect(parseLink(' http://10.147.17.5:7788/connect?token=abc ')).toEqual({
      baseUrl: 'http://10.147.17.5:7788',
      token: 'abc',
    });
    expect(() => parseLink('http://10.147.17.5:7788/')).toThrow('Copy the link');
  });
});
