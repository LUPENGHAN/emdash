import { spawn, type ChildProcess } from 'node:child_process';
import type { LaunchMcpServer, McpHealth, McpServerStatus } from '../api';

const DEPRECATED_ALTERNATIVES: Record<string, string> = {
  '@modelcontextprotocol/server-github':
    'Use the official github/github-mcp-server binary instead.',
};

const HANDSHAKE_TIMEOUT_MS = 20_000;
const EXACT_VERSION = /^v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'emdash', version: '0' },
  },
};

type JsonRpcMessage = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};

export function classifyMcpServer(server: LaunchMcpServer): {
  kind: McpServerStatus['kind'];
  packageName: string | null;
} {
  if (server.transport === 'http') return { kind: 'http', packageName: null };
  const command = server.command?.trim() ?? '';
  const args = server.args ?? [];
  const joined = [command, ...args].join(' ');
  if (/\bdocker\b/.test(command)) return { kind: 'docker', packageName: null };
  const npx = /(?:^|\s)(?:npx|npm)\b/.test(command) ? npmPackage(args) : null;
  if (npx) return { kind: 'npm', packageName: npx };
  const uvx = /(?:^|\s)uvx\b/.test(joined) ? pythonPackage(args) : null;
  if (uvx) return { kind: 'pypi', packageName: uvx };
  return { kind: 'local', packageName: null };
}

/** Splits `name@1.2.3` (npm) or `name==1.2.3` / `name@1.2.3` (uvx); ranges and tags pin nothing. */
export function splitPackageSpec(
  kind: 'npm' | 'pypi',
  spec: string
): { name: string; version: string | null } {
  if (kind === 'npm') {
    const at = spec.lastIndexOf('@');
    if (at <= 0) return { name: spec, version: null };
    return {
      name: spec.slice(0, at),
      version: EXACT_VERSION.exec(spec.slice(at + 1))?.[1] ?? null,
    };
  }
  const match = /^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*(.*)$/.exec(spec.trim());
  if (!match?.[1]) return { name: spec, version: null };
  const pin = /^(?:==|@)\s*([^,;\s]+)$/.exec(match[2] ?? '');
  return { name: match[1], version: pin?.[1] ? (EXACT_VERSION.exec(pin[1])?.[1] ?? null) : null };
}

export async function checkMcpServer(server: LaunchMcpServer): Promise<McpServerStatus> {
  const classified = classifyMcpServer(server);
  const base: McpServerStatus = {
    name: server.name,
    kind: classified.kind,
    currentVersion: null,
    latestVersion: null,
    deprecated: null,
    note: null,
    updateAvailable: false,
  };
  if (classified.kind === 'npm' && classified.packageName) {
    const { name, version } = splitPackageSpec('npm', classified.packageName);
    const [latest, current] = await Promise.all([
      fetchJson(`https://registry.npmjs.org/${encodeNpm(name)}/latest`),
      version ? fetchJson(`https://registry.npmjs.org/${encodeNpm(name)}/${version}`) : null,
    ]);
    const latestVersion = typeof latest?.version === 'string' ? latest.version : null;
    const deprecated =
      (typeof current?.deprecated === 'string' ? current.deprecated : null) ??
      (typeof latest?.deprecated === 'string' ? latest.deprecated : null) ??
      DEPRECATED_ALTERNATIVES[name] ??
      null;
    return {
      ...base,
      currentVersion: version,
      latestVersion,
      deprecated,
      note: version ? null : 'No version is pinned, so npx may keep an older copy.',
      updateAvailable: Boolean(version && latestVersion && latestVersion !== version),
    };
  }
  if (classified.kind === 'pypi' && classified.packageName) {
    const { name, version } = splitPackageSpec('pypi', classified.packageName);
    const body = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    const info = body?.info;
    const latestVersion =
      info && typeof info === 'object' && 'version' in info && typeof info.version === 'string'
        ? info.version
        : null;
    return {
      ...base,
      currentVersion: version,
      latestVersion,
      note: version ? null : 'No version is pinned.',
      updateAvailable: Boolean(version && latestVersion && latestVersion !== version),
    };
  }
  return base;
}

export async function checkMcpHealth(server: LaunchMcpServer): Promise<McpHealth> {
  if (server.transport === 'http') {
    if (!server.url) return { ok: false, tools: null, error: 'No URL' };
    try {
      const response = await fetch(server.url, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'user-agent': 'emdash',
          ...server.headers,
        },
        body: JSON.stringify(INITIALIZE),
      });
      if (!response.ok) return { ok: false, tools: null, error: `HTTP ${response.status}` };
      const message = await readHttpMessage(response);
      if (message?.error) return { ok: false, tools: null, error: rpcError(message) };
      return message && 'result' in message
        ? { ok: true, tools: null, error: null }
        : { ok: false, tools: null, error: 'Not an MCP response' };
    } catch (error) {
      return {
        ok: false,
        tools: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const command = server.command?.trim();
  if (!command) return { ok: false, tools: null, error: 'No command' };
  return handshake(command, server.args ?? [], server.env ?? {});
}

function npmPackage(args: readonly string[]): string | null {
  const tokens = args.filter((arg) => arg !== '-y' && arg !== '--yes');
  return tokens.find((token) => !token.startsWith('-')) ?? null;
}

function pythonPackage(args: readonly string[]): string | null {
  return args.find((token) => !token.startsWith('-')) ?? null;
}

function encodeNpm(packageName: string): string {
  return packageName.replace('/', '%2f');
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json', 'user-agent': 'emdash' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A JSON body, or the first `data:` event of a streamable-HTTP (SSE) reply. */
async function readHttpMessage(response: Response): Promise<JsonRpcMessage | null> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return asMessage(await response.json().catch(() => null));
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const message = asMessage(parseJson(line.slice(5).trim()));
        if (message) return message;
      }
      if (done) return null;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asMessage(value: unknown): JsonRpcMessage | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRpcMessage)
    : null;
}

function rpcError(message: JsonRpcMessage): string {
  return typeof message.error?.message === 'string' ? message.error.message : 'MCP error';
}

function handshake(
  command: string,
  args: readonly string[],
  env: Record<string, string>
): Promise<McpHealth> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: McpHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(result);
    };
    const fail = (fallback: string) =>
      finish({ ok: false, tools: null, error: stderr.trim().slice(-2000) || fallback });
    const timer = setTimeout(() => fail('Timed out'), HANDSHAKE_TIMEOUT_MS);
    const send = (message: object) => {
      if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const receive = (message: JsonRpcMessage) => {
      if (message.id === 1) {
        if (message.error) return finish({ ok: false, tools: null, error: rpcError(message) });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (message.id === 2) {
        const tools = (message.result as { tools?: unknown } | undefined)?.tools;
        finish({ ok: true, tools: Array.isArray(tools) ? tools.length : null, error: null });
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        const message = asMessage(parseJson(stdout.slice(0, newline).trim()));
        stdout = stdout.slice(newline + 1);
        if (message) receive(message);
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdin?.on('error', (error) => fail(error.message));
    child.on('error', (error) => fail(error.message));
    child.on('exit', (code, signal) =>
      fail(code === null ? `Stopped by ${signal}` : `Exited ${code}`)
    );
    send(INITIALIZE);
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => child.kill()
    );
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
