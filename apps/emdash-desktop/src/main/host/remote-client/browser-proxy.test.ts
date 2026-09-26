import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBrowserProxy, type BrowserProxy } from './browser-proxy';

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));

// Stands in for the other computer: tunnels are plain TCP connections from here.
const localTunnel = vi.fn(
  (host: string, port: number) =>
    new Promise<Duplex>((resolve, reject) => {
      const socket = connect(port, host, () => resolve(socket));
      socket.once('error', reject);
    })
);

describe('startBrowserProxy', () => {
  let site: Server;
  let proxy: BrowserProxy;

  afterEach(async () => {
    await proxy?.close();
    await new Promise<void>((resolve) => site?.close(() => resolve()));
  });

  async function setup() {
    site = createServer((req, res) => res.end(`site saw ${req.method} ${req.url}`));
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()));
    proxy = await startBrowserProxy(localTunnel);
    return (site.address() as AddressInfo).port;
  }

  it('carries plain HTTP proxy requests through a tunnel', async () => {
    const sitePort = await setup();
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://localhost:${sitePort}/app?x=1`,
          headers: { host: `localhost:${sitePort}` },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('site saw GET /app?x=1');
    expect(localTunnel).toHaveBeenCalledWith('localhost', sitePort);
  });

  it('carries CONNECT tunnels (HTTPS, WebSockets) byte for byte', async () => {
    const sitePort = await setup();
    const socket = connect(proxy.port, '127.0.0.1');
    socket.write(`CONNECT 127.0.0.1:${sitePort} HTTP/1.1\r\nHost: 127.0.0.1:${sitePort}\r\n\r\n`);
    const established = await new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(String(chunk)))
    );
    expect(established).toContain('200 Connection Established');

    socket.write(`GET /inner HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    const response = await new Promise<string>((resolve) => {
      let text = '';
      socket.on('data', (chunk) => (text += chunk));
      socket.on('end', () => resolve(text));
    });
    expect(response).toContain('site saw GET /inner');
  });
});
