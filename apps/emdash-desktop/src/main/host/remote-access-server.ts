import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { WireTransport } from '@emdash/wire/rpc';
import { webSocketTransport, type WebSocketLike } from '@emdash/wire/rpc';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RemoteAccessServer } from '@core/features/remote-access/node/remote-access-service';

const COOKIE = 'emdash_remote';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const WIRE_PATH = '/wire';
const CONNECT_PATH = '/connect';

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
};

export type RemoteAccessServerDeps = {
  /** The built renderer (`out/renderer`), served as the browser app. */
  rendererRoot: string;
  /** Serves the desktop controllers over a browser's transport; returns its disposer. */
  openSession: (transport: WireTransport) => () => void;
};

/**
 * HTTP + WebSocket server for browser access. A browser signs in once through the
 * `/connect?token=…` link, which trades the token for an HttpOnly, SameSite=Strict
 * cookie; every file and the `/wire` socket then require that cookie, and the socket
 * also requires a same-origin `Origin` so other sites cannot ride the cookie.
 */
export function createRemoteAccessServer(deps: RemoteAccessServerDeps): RemoteAccessServer {
  const root = normalize(deps.rendererRoot);
  let server: Server | null = null;
  let sockets: WebSocketServer | null = null;
  const sessions = new Map<WebSocket, () => void>();

  const closeAll = (): void => {
    for (const [socket, dispose] of sessions) {
      dispose();
      socket.terminate();
    }
    sessions.clear();
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
        void handleRequest(request, response, { root, token, authorized }).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      http.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://local');
        const sameOrigin = request.headers.origin === `http://${request.headers.host}`;
        if (url.pathname !== WIRE_PATH || !authorized(request) || !sameOrigin) {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
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
  context: { root: string; token: string; authorized: (request: IncomingMessage) => boolean }
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

  if (!context.authorized(request)) {
    return sendText(
      response,
      401,
      'Open the link from Emdash → Settings → Remote access to use Emdash in this browser.'
    );
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
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'private, max-age=3600',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
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
