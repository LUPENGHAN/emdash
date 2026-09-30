import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import type { WireTransport } from '@emdash/wire/rpc';
import { webSocketTransport, type WebSocketLike } from '@emdash/wire/rpc';
import { createWebSocketStream, WebSocketServer, type WebSocket } from 'ws';
import type { RemoteServerInfo } from '@core/features/remote-access/api';
import type { RemoteAccessServer } from '@core/features/remote-access/node/remote-access-service';

const COOKIE = 'emdash_remote';
// A year: each device signs in with the link about once; a new link still signs all out.
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const WIRE_PATH = '/wire';
const CONNECT_PATH = '/connect';
const INFO_PATH = '/info';
/** Raw TCP to a host:port reachable from this computer, for a client's built-in browser. */
const TUNNEL_PATH = '/tunnel';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Served without sign-in: browsers fetch a web app's manifest and icons without the
 * page's cookie (and these hold nothing private), so "Add to Home screen" works.
 */
const PUBLIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]);

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Types worth compressing: text and uncompressed binaries (woff/woff2/images already are). */
const COMPRESSIBLE = /^(text\/|application\/(json|wasm)|image\/svg|font\/ttf)/;

type Encoding = 'br' | 'gzip';

/** The encoding to answer with, from the request's Accept-Encoding (brotli first). */
function pickEncoding(header: string | string[] | undefined): Encoding | null {
  const accepted = String(header ?? '')
    .split(',')
    .map((part) => part.trim().split(';'))
    .filter(([, q]) => !q || !/^q=0(\.0*)?$/.test(q.trim()))
    .map(([name]) => name!.toLowerCase());
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return null;
}

function compress(body: Buffer, encoding: Encoding): Promise<Buffer> {
  // Fast settings: the app bundle is ~20 MB, compressed once per build on first request.
  return encoding === 'br'
    ? brotliAsync(body, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gzipAsync(body, { level: 6 });
}

export type RemoteAccessServerDeps = {
  /** The built renderer (`out/renderer`), served as the browser app. */
  rendererRoot: string;
  /** Serves the desktop controllers over a browser's transport; returns its disposer. */
  openSession: (transport: WireTransport) => () => void;
  /** Name and build shown to connecting apps. */
  info: () => RemoteServerInfo;
};

/**
 * HTTP + WebSocket server for browser access. A browser signs in once through the
 * `/connect?token=…` link, which trades the token for an HttpOnly, SameSite=Strict
 * cookie; every file and the `/wire` socket then require that cookie, and the socket
 * also requires a same-origin `Origin` so other sites cannot ride the cookie. Another
 * Emdash connects the same way (sending the cookie itself) and may open `/tunnel`
 * sockets so its built-in browser sees what this computer sees.
 */
export function createRemoteAccessServer(deps: RemoteAccessServerDeps): RemoteAccessServer {
  const root = normalize(deps.rendererRoot);
  let server: Server | null = null;
  let sockets: WebSocketServer | null = null;
  const sessions = new Map<WebSocket, () => void>();
  const tunnels = new Set<WebSocket>();
  // Built files never change while the app runs, so each is compressed once.
  const compressed = new Map<string, Promise<Buffer>>();

  const closeAll = (): void => {
    for (const [socket, dispose] of sessions) {
      dispose();
      socket.terminate();
    }
    sessions.clear();
    for (const socket of tunnels) socket.terminate();
    tunnels.clear();
  };

  return {
    async start({ host, port, token }) {
      const authorized = (request: IncomingMessage) =>
        matches(readCookie(request.headers.cookie, COOKIE), token);

      const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
      wss.on('connection', (socket: WebSocket) => {
        const dispose = deps.openSession(webSocketTransport(socket as unknown as WebSocketLike));
        sessions.set(socket, dispose);
        socket.on('close', () => {
          sessions.get(socket)?.();
          sessions.delete(socket);
        });
      });

      const http = createServer((request, response) => {
        void handleRequest(request, response, {
          root,
          token,
          authorized,
          info: deps.info,
          compressed,
        }).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      http.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://local');
        const sameOrigin = request.headers.origin === `http://${request.headers.host}`;
        if (!authorized(request) || !sameOrigin) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          return;
        }
        if (url.pathname === WIRE_PATH) {
          wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
          return;
        }
        const target = url.pathname === TUNNEL_PATH ? parseTarget(url.searchParams) : null;
        if (!target) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          tunnels.add(ws);
          const stream = createWebSocketStream(ws);
          const tcp = connectTcp(target.port, target.host);
          const end = () => {
            tunnels.delete(ws);
            stream.destroy();
            tcp.destroy();
          };
          stream.on('error', end).on('close', end);
          tcp.on('error', end).on('close', end);
          stream.pipe(tcp).pipe(stream);
        });
      });

      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          resolve();
        });
      });
      server = http;
      sockets = wss;
    },
    async stop() {
      closeAll();
      sockets?.close();
      sockets = null;
      const http = server;
      server = null;
      if (!http) return;
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
    clientCount: () => sessions.size,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    root: string;
    token: string;
    authorized: (request: IncomingMessage) => boolean;
    info: () => RemoteServerInfo;
    compressed: Map<string, Promise<Buffer>>;
  }
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://local');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (url.pathname === CONNECT_PATH) {
    if (!matches(url.searchParams.get('token'), context.token)) {
      return sendText(response, 401, 'This link is no longer valid. Copy a new one from Emdash.');
    }
    response.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${context.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
      Location: '/',
    });
    response.end();
    return;
  }

  if (!PUBLIC_PATHS.has(url.pathname) && !context.authorized(request)) {
    return sendText(
      response,
      401,
      'Open the link from Emdash → Settings → Remote access to use Emdash in this browser.'
    );
  }
  if (url.pathname === INFO_PATH) {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(context.info()));
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendText(response, 405, 'Method not allowed');
  }

  const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  let file = normalize(join(context.root, relPath));
  if (!file.startsWith(context.root + sep)) return sendText(response, 403, 'Forbidden');

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    // Client-side routes fall back to the app shell, as the app:// protocol does.
    file = join(context.root, 'index.html');
    body = await readFile(file);
  }
  const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
  const html = type.startsWith('text/html');
  const headers: Record<string, string> = {
    'Content-Type': type,
    // Built assets carry a content hash in their name, so a new build is a new URL.
    'Cache-Control': html
      ? 'no-store'
      : relPath.startsWith('assets/')
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=3600',
  };
  const encoding =
    COMPRESSIBLE.test(type) && body.length > 1024
      ? pickEncoding(request.headers['accept-encoding'])
      : null;
  if (encoding) {
    const key = `${file}\0${encoding}`;
    let pending = html ? undefined : context.compressed.get(key);
    if (!pending) {
      pending = compress(body, encoding);
      if (!html) context.compressed.set(key, pending);
      pending.catch(() => context.compressed.delete(key));
    }
    body = await pending;
    headers['Content-Encoding'] = encoding;
  }
  if (COMPRESSIBLE.test(type)) headers.Vary = 'Accept-Encoding';
  headers['Content-Length'] = String(body.length);
  response.writeHead(200, headers);
  response.end(request.method === 'HEAD' ? undefined : body);
}

function parseTarget(params: URLSearchParams): { host: string; port: number } | null {
  const host = params.get('host');
  const port = Number(params.get('port'));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function matches(candidate: string | null, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
