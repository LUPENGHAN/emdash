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
import type { RemoteAccessDevice, RemoteServerInfo } from '@core/features/remote-access/api';
import type { RemoteAccessAuth } from '@core/features/remote-access/node/remote-access-auth';
import type { RemoteAccessServer } from '@core/features/remote-access/node/remote-access-service';

const COOKIE = 'emdash_remote';
// A year: each device signs in with the link about once; a new link still signs all out.
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const WIRE_PATH = '/wire';
const CONNECT_PATH = '/connect';
/** POST `{ key, client?, name? }`: signs a device in with the access key. */
const PAIR_PATH = '/pair';
const INFO_PATH = '/info';
const MAX_PAIR_BODY_BYTES = 4096;
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
  /** Signed-in devices and the access key. */
  auth: RemoteAccessAuth;
};

/** Whoever a request comes from: the computer's link itself, or a signed-in device. */
type Caller = { kind: 'link' } | { kind: 'device'; device: RemoteAccessDevice };

/**
 * HTTP + WebSocket server for browser access. A device signs in once, through the
 * `/connect?token=…` link or with the access key (`/pair`, or the sign-in page the
 * server shows when a key is set), and gets an HttpOnly, SameSite=Lax cookie holding
 * a token of its own, so it can be signed out alone. Every file and the `/wire` socket
 * then require that cookie, and the socket also requires a same-origin `Origin` so other
 * sites cannot ride it. Wrong links and keys lock the address out for a while. Another
 * Emdash connects with the link token as its cookie and may open `/tunnel` sockets so
 * its built-in browser sees what this computer sees.
 */
export function createRemoteAccessServer(deps: RemoteAccessServerDeps): RemoteAccessServer {
  const root = normalize(deps.rendererRoot);
  let server: Server | null = null;
  let sockets: WebSocketServer | null = null;
  let stopWatchingRevokes: (() => void) | null = null;
  const sessions = new Map<WebSocket, { dispose: () => void; deviceId: string | null }>();
  const tunnels = new Set<WebSocket>();
  // Built files never change while the app runs, so each is compressed once.
  const compressed = new Map<string, Promise<Buffer>>();

  const closeAll = (): void => {
    for (const [socket, { dispose }] of sessions) {
      dispose();
      socket.terminate();
    }
    sessions.clear();
    for (const socket of tunnels) socket.terminate();
    tunnels.clear();
  };

  return {
    async start({ host, port, token }) {
      const caller = async (request: IncomingMessage): Promise<Caller | null> => {
        const cookie = readCookie(request.headers.cookie, COOKIE);
        if (matches(cookie, token)) return { kind: 'link' };
        const device = await deps.auth.identify(cookie);
        return device ? { kind: 'device', device } : null;
      };

      const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
      wss.on(
        'connection',
        (socket: WebSocket, _request: IncomingMessage, deviceId: string | null) => {
          const dispose = deps.openSession(webSocketTransport(socket as unknown as WebSocketLike));
          sessions.set(socket, { dispose, deviceId });
          socket.on('close', () => {
            sessions.get(socket)?.dispose();
            sessions.delete(socket);
          });
        }
      );
      // A device signed out is disconnected at once, not at its next reload.
      stopWatchingRevokes = deps.auth.onRevoked((ids) => {
        for (const [socket, session] of sessions) {
          if (session.deviceId && ids.includes(session.deviceId)) socket.terminate();
        }
      });

      const http = createServer((request, response) => {
        void handleRequest(request, response, {
          root,
          token,
          caller,
          auth: deps.auth,
          info: deps.info,
          compressed,
        }).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      http.on('upgrade', (request, socket, head) => {
        void (async () => {
          const url = new URL(request.url ?? '/', 'http://local');
          const who = await caller(request);
          if (!who || !isSameOrigin(request)) {
            socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
          }
          const deviceId = who.kind === 'device' ? who.device.id : null;
          if (deviceId) void deps.auth.touch(deviceId, clientAddress(request));
          if (url.pathname === WIRE_PATH) {
            wss.handleUpgrade(request, socket, head, (ws) =>
              wss.emit('connection', ws, request, deviceId)
            );
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
        })().catch(() => socket.destroy());
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
      stopWatchingRevokes?.();
      stopWatchingRevokes = null;
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
    caller: (request: IncomingMessage) => Promise<Caller | null>;
    auth: RemoteAccessAuth;
    info: () => RemoteServerInfo;
    compressed: Map<string, Promise<Buffer>>;
  }
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://local');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const address = clientAddress(request);

  if (url.pathname === CONNECT_PATH) {
    const wait = context.auth.lockedFor(address);
    if (wait > 0) return sendLocked(response, wait);
    const candidate = url.searchParams.get('token');
    const device = {
      clientId: url.searchParams.get('client') || null,
      name: url.searchParams.get('name') || deviceNameFromUserAgent(request.headers['user-agent']),
      address,
    };
    let cookieToken: string;
    if (matches(candidate, context.token)) {
      // The link: this device gets a token of its own.
      cookieToken = (await context.auth.issue(device)).token;
    } else {
      // A device's own token (the app signs in with it at every start).
      const known = await context.auth.identify(candidate);
      if (!known || !candidate) {
        context.auth.failToken(address);
        return sendText(response, 401, 'This link is no longer valid. Copy a new one from Emdash.');
      }
      void context.auth.touch(known.id, address);
      cookieToken = candidate;
    }
    response.writeHead(302, {
      'Set-Cookie': deviceCookie(cookieToken, request),
      Location: '/',
    });
    response.end();
    return;
  }

  if (url.pathname === PAIR_PATH) return pairWithAccessKey(request, response, context, address);

  const who = PUBLIC_PATHS.has(url.pathname) ? null : await context.caller(request);
  if (!PUBLIC_PATHS.has(url.pathname) && !who) {
    // Browsers get a page to type the access key in, when one is set.
    if (
      (request.headers.accept ?? '').includes('text/html') &&
      (await context.auth.hasAccessKey())
    ) {
      response.writeHead(401, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(signInPage(context.info().name));
      return;
    }
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

/**
 * Signs a device in with the access key: `{ key, client?, name? }` as JSON. Answers
 * `{ token, name }` (and sets the cookie) on success; wrong keys count toward the
 * address's lockout. A browser page may only post here from this server's own origin.
 */
async function pairWithAccessKey(
  request: IncomingMessage,
  response: ServerResponse,
  context: { auth: RemoteAccessAuth; info: () => RemoteServerInfo },
  address: string
): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'method' });
  if (request.headers.origin && !isSameOrigin(request)) {
    return sendJson(response, 403, { error: 'origin' });
  }
  let input: { key?: unknown; client?: unknown; name?: unknown };
  try {
    input = JSON.parse(await readBody(request, MAX_PAIR_BODY_BYTES)) as typeof input;
  } catch {
    return sendJson(response, 400, { error: 'body' });
  }
  if (typeof input.key !== 'string') return sendJson(response, 400, { error: 'body' });
  const check = await context.auth.checkAccessKey(input.key, address);
  if (check.result === 'off') return sendJson(response, 404, { error: 'off' });
  if (check.result === 'locked') return sendLocked(response, check.retryAfterMs);
  if (check.result === 'wrong') {
    return sendJson(response, 401, { error: 'wrong', remaining: check.remaining });
  }
  const name =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim().slice(0, 80)
      : deviceNameFromUserAgent(request.headers['user-agent']);
  const clientId =
    typeof input.client === 'string' && input.client ? input.client.slice(0, 80) : null;
  const { token } = await context.auth.issue({ clientId, name, address });
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': deviceCookie(token, request),
  });
  response.end(JSON.stringify({ token, name: context.info().name }));
}

/** The sign-in cookie; HTTPS-only when the page came through an HTTPS proxy. */
function deviceCookie(token: string, request: IncomingMessage): string {
  // Lax, not Strict: a phone opening Emdash from a home-screen shortcut or a link in
  // another app is a cross-site navigation, which Strict would send without the
  // cookie (looking signed out). Sockets still require a same-origin Origin.
  const secure = viaLocalProxy(request) && request.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${
    secure ? '; Secure' : ''
  }`;
}

function viaLocalProxy(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * Who is asking: the socket's address, or, through a proxy on this computer (a tunnel
 * such as cloudflared, or Tailscale Serve), the visitor it names.
 */
export function clientAddress(request: IncomingMessage): string {
  const remote = request.socket.remoteAddress ?? 'unknown';
  if (!viaLocalProxy(request)) return remote;
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() || undefined;
  };
  return header('cf-connecting-ip') ?? header('x-forwarded-for') ?? remote;
}

/** "Chrome on Windows", "Safari on iPhone"…, for the list of signed-in devices. */
export function deviceNameFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/EmdashAndroid\//.test(ua)) return 'Emdash for Android';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Electron\//.test(ua)
      ? 'Emdash'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Browser';
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendLocked(response: ServerResponse, retryAfterMs: number): void {
  const seconds = Math.ceil(retryAfterMs / 1000);
  response.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(seconds),
  });
  response.end(JSON.stringify({ error: 'locked', retryAfter: seconds }));
}

/** The page a browser without a sign-in sees when an access key is set. */
function signInPage(computerName: string): string {
  const name = escapeHtml(computerName);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emdash</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:Canvas;color:CanvasText}
form{width:min(340px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px}
h1{font-size:20px;margin:0}p{margin:0;opacity:.7;font-size:14px;line-height:1.5}
input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:Canvas;color:CanvasText}
button{font:inherit;padding:10px 12px;border-radius:8px;border:0;background:CanvasText;color:Canvas;cursor:pointer}
#error{color:#d33;min-height:1.5em}
</style></head>
<body><form id="form" data-name="${name}">
<h1 id="title"></h1><p id="hint"></p>
<input id="key" type="password" autocomplete="current-password" autofocus required>
<button id="go" type="submit"></button><p id="error"></p>
</form>
<script>
const zh = navigator.language.toLowerCase().startsWith('zh');
const name = document.getElementById('form').dataset.name;
const t = zh
  ? { title: '登录 ' + name, hint: '输入你在 Emdash 设置 → 远程访问 里设置的访问密钥。', go: '登录', wrong: (n) => '密钥不对，还能再试 ' + n + ' 次。', locked: (m) => '试错次数太多，请 ' + m + ' 分钟后再试。', off: '这台电脑没有开启密钥登录。', failed: '登录失败，请稍后再试。' }
  : { title: 'Sign in to ' + name, hint: 'Enter the access key set in Emdash → Settings → Remote access.', go: 'Sign in', wrong: (n) => 'Wrong key. ' + n + ' tries left.', locked: (m) => 'Too many tries. Try again in ' + m + ' min.', off: 'Key sign-in is off on this computer.', failed: 'Could not sign in. Try again later.' };
document.getElementById('title').textContent = t.title;
document.getElementById('hint').textContent = t.hint;
document.getElementById('go').textContent = t.go;
const error = document.getElementById('error');
document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  try {
    const res = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: document.getElementById('key').value }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return location.replace('/');
    if (body.error === 'wrong') error.textContent = t.wrong(body.remaining);
    else if (body.error === 'locked') error.textContent = t.locked(Math.ceil(body.retryAfter / 60));
    else if (body.error === 'off') error.textContent = t.off;
    else error.textContent = t.failed;
  } catch { error.textContent = t.failed; }
});
</script></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Whether a socket comes from the page this server serves: its Origin names this host,
 * over http or https (behind an HTTPS proxy such as Tailscale Serve). A proxy on this
 * computer forwards the name the browser used in X-Forwarded-Host.
 */
export function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [request.headers.host];
  if (viaLocalProxy(request)) {
    const forwarded = request.headers['x-forwarded-host'];
    hosts.push(...(Array.isArray(forwarded) ? forwarded : [forwarded]));
  }
  return hosts.some(
    (host) => typeof host === 'string' && host.split(',')[0]!.trim() === originHost
  );
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
