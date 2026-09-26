import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WireMessage, WireTransport } from '@emdash/wire/rpc';
import { webSocketTransport, type WebSocketLike } from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRemoteAccessServer } from './remote-access-server';

const TOKEN = 'secret-token-123';

type Response = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

function get(port: number, pathname: string, cookie?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: pathname, headers: cookie ? { cookie } : {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function openSocket(port: number, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wire`, { headers });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('createRemoteAccessServer', () => {
  let root: string;
  let port: number;
  let sessions: WireTransport[];
  let server: ReturnType<typeof createRemoteAccessServer>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'emdash-remote-'));
    await writeFile(path.join(root, 'index.html'), '<html>app</html>');
    await writeFile(path.join(root, 'app.js'), 'console.log(1)');
    sessions = [];
    server = createRemoteAccessServer({
      rendererRoot: root,
      openSession: (transport) => {
        sessions.push(transport);
        // Echo so the test can see traffic flow both ways.
        transport.onMessage((message) => transport.post(message));
        return vi.fn();
      },
    });
    // Find a free port, then listen on it.
    const probe = await import('node:net').then(({ createServer }) => createServer());
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await server.start({ host: '127.0.0.1', port, token: TOKEN });
  });

  afterEach(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('turns the link token into a cookie and serves the app with it', async () => {
    expect((await get(port, '/')).status).toBe(401);
    expect((await get(port, '/connect?token=wrong')).status).toBe(401);

    const connect = await get(port, `/connect?token=${TOKEN}`);
    expect(connect.status).toBe(302);
    expect(connect.headers.location).toBe('/');
    const setCookie = String(connect.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
    const cookie = setCookie.split(';')[0]!;

    const app = await get(port, '/', cookie);
    expect(app.status).toBe(200);
    expect(app.body).toBe('<html>app</html>');
    expect((await get(port, '/app.js', cookie)).headers['content-type']).toContain('javascript');
    // Unknown routes fall back to the app shell; traversal never leaves the root.
    expect((await get(port, '/tasks/123', cookie)).body).toBe('<html>app</html>');
    expect((await get(port, '/..%2f..%2fetc%2fpasswd', cookie)).status).toBe(403);
  });

  it('opens a wire session only for a signed-in, same-origin socket', async () => {
    const origin = `http://127.0.0.1:${port}`;
    const cookie = `emdash_remote=${TOKEN}`;
    await expect(openSocket(port, { origin })).rejects.toThrow();
    await expect(openSocket(port, { cookie, origin: 'http://evil.example' })).rejects.toThrow();

    const socket = await openSocket(port, { cookie, origin });
    const client = webSocketTransport(socket as unknown as WebSocketLike);
    const echoed = new Promise<WireMessage>((resolve) => client.onMessage(resolve));
    client.post({ kind: 'cancel', id: 'call-1' });

    expect(await echoed).toEqual({ kind: 'cancel', id: 'call-1' });
    expect(sessions).toHaveLength(1);
    expect(server.clientCount()).toBe(1);
    client.close?.();
  });

  it('disconnects browsers when it stops', async () => {
    const socket = await openSocket(port, {
      cookie: `emdash_remote=${TOKEN}`,
      origin: `http://127.0.0.1:${port}`,
    });
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await server.stop();
    await closed;
    expect(server.clientCount()).toBe(0);
  });
});
