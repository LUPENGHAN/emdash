import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { session } from 'electron';

/** Opens a raw TCP stream to host:port as seen from the other computer. */
export type OpenTunnel = (host: string, port: number) => Promise<Duplex>;

export type BrowserProxy = { port: number; close(): Promise<void> };

/**
 * A local HTTP proxy for the built-in browser while driving another computer: CONNECT
 * (HTTPS, WebSockets) and plain HTTP requests are carried over tunnels to the other
 * computer, so `localhost:3000` there — or anything on its network — opens here.
 */
export async function startBrowserProxy(openTunnel: OpenTunnel): Promise<BrowserProxy> {
  const sockets = new Set<Socket | Duplex>();
  const track = <T extends Socket | Duplex>(stream: T): T => {
    sockets.add(stream);
    stream.once('close', () => sockets.delete(stream));
    return stream;
  };

  const server: Server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Proxy requests need an absolute URL');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('Only http:// is proxied without CONNECT');
      return;
    }
    const port = Number(target.port || 80);
    void openTunnel(target.hostname, port).then(
      (tunnel) => {
        track(tunnel);
        const headers = { ...req.headers };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];
        const upstream = httpRequest(
          {
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers,
            // Without an agent, Node uses createConnection (with one it would dial itself).
            createConnection: () => tunnel as Socket,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          }
        );
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
          tunnel.destroy();
        });
        req.pipe(upstream);
      },
      () => {
        res.writeHead(502).end('Could not reach it from the other computer');
      }
    );
  });

  server.on('connect', (req, client: Socket, head: Buffer) => {
    track(client);
    const [host, portText] = splitHostPort(req.url ?? '');
    const port = Number(portText);
    if (!host || !Number.isInteger(port)) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    void openTunnel(host, port).then(
      (tunnel) => {
        track(tunnel);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) tunnel.write(head);
        const end = () => {
          client.destroy();
          tunnel.destroy();
        };
        client.on('error', end).on('close', end);
        tunnel.on('error', end).on('close', end);
        client.pipe(tunnel).pipe(client);
      },
      () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    );
  });
  server.on('connection', (socket) => track(socket));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `host:port` or `[ipv6]:port`. */
function splitHostPort(value: string): [string, string] {
  const bracket = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (bracket) return [bracket[1]!, bracket[2]!];
  const index = value.lastIndexOf(':');
  return index > 0 ? [value.slice(0, index), value.slice(index + 1)] : [value, ''];
}

// ── Applying the proxy to the built-in browser's sessions ─────────────────────────

let proxyPort: number | null = null;
const browserPartitions = new Set<string>();

async function applyTo(partition: string): Promise<void> {
  const ses = session.fromPartition(partition);
  await ses.setProxy(
    proxyPort === null
      ? { mode: 'direct' }
      : {
          proxyRules: `http://127.0.0.1:${proxyPort}`,
          // Chromium never proxies loopback by default; the other computer's
          // localhost is the point.
          proxyBypassRules: '<-loopback>',
        }
  );
  await ses.closeAllConnections();
}

/** Routes a built-in browser partition through the current proxy (if any) before use. */
export async function applyRemoteBrowserProxy(partition: string): Promise<void> {
  browserPartitions.add(partition);
  await applyTo(partition);
}

/** Switches every known browser partition to the proxy on `port`, or back to direct. */
export async function setRemoteBrowserProxyPort(port: number | null): Promise<void> {
  proxyPort = port;
  await Promise.all([...browserPartitions].map((partition) => applyTo(partition)));
}
