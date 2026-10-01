import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildTerminalEnv } from '@emdash/core/services/pty/api';
import * as nodePty from 'node-pty';
import type {
  AgentUsage,
  OfficialAccount,
  UsageLimits,
  UsageLimitsService,
  UsageWindow,
} from '../api';
import { ACCOUNT_HOME_ENV } from './official-accounts';

const execFileAsync = promisify(execFile);
const PROBE_TTL_MS = 5 * 60_000;
/** Cursor's pools are monthly and its probe opens its whole terminal UI: read less often. */
const CURSOR_PROBE_TTL_MS = 15 * 60_000;
const CODEX_TAIL_BYTES = 2 * 1024 * 1024;

type Env = { home: string; env: NodeJS.ProcessEnv };

export type UsageLimitsDeps = {
  env?: Env;
  now?: () => number;
  /** Runs `claude -p /usage`; returns its JSON `result` text. */
  runClaudeUsage?: () => Promise<string>;
  /** Runs `cursor-agent about --format json`; returns its stdout. */
  runCursorAbout?: () => Promise<string>;
  /** Shows `/usage` in Cursor's terminal UI; returns the screen text. */
  runCursorUsage?: () => Promise<string>;
  /** Asks Codex for the signed-in account's rate limits (`account/rateLimits/read`). */
  readCodexRateLimits?: (env: Env) => Promise<Record<string, unknown>>;
  /** The official accounts, and each one's (readied) config dir. */
  listAccounts?: () => Promise<OfficialAccount[]>;
  accountHome?: (account: OfficialAccount) => Promise<string>;
};

/**
 * Subscription limit usage for the agents whose vendors expose it:
 * - Codex reports the signed-in account's rate limits (5h and weekly windows) through
 *   its app server, as its own `/status` does; this calls no model. When that fails,
 *   the newest session file's `token_count` event still has the last numbers (they may
 *   be another account's, since accounts share sessions).
 * - Claude Code prints them for the local `/usage` command, which calls no model; it is
 *   probed with `claude -p /usage --no-session-persistence` and cached for a while.
 * - Cursor shows its monthly Auto and API pools only in its terminal UI's `/usage`
 *   (no model call); that is opened hidden now and then. `about` gives the plan when
 *   that fails.
 */
export function createUsageLimitsService(deps: UsageLimitsDeps = {}): UsageLimitsService {
  const env = deps.env ?? { home: os.homedir(), env: process.env };
  const now = deps.now ?? Date.now;
  const runClaudeUsage = deps.runClaudeUsage ?? (() => runClaudeUsageCommand(env));
  const runCursorAbout = deps.runCursorAbout ?? (() => runCursorAboutCommand(env));
  const runCursorUsage = deps.runCursorUsage ?? (() => runCursorUsageCommand(env));
  const readCodexRateLimits = deps.readCodexRateLimits ?? readCodexRateLimitsCommand;

  // The probes spawn a CLI (and ask the vendor), so their results are cached.
  const cached = (
    agent: AgentUsage['agent'],
    read: () => Promise<AgentUsage>,
    ttl = PROBE_TTL_MS
  ) => {
    let cache: { value: AgentUsage; at: number } | null = null;
    let inFlight: Promise<AgentUsage> | null = null;
    return async (refresh: boolean): Promise<AgentUsage> => {
      if (!refresh && cache && now() - cache.at < ttl) return cache.value;
      inFlight ??= read()
        .catch((error) => unavailable(agent, now(), errorMessage(error)))
        .finally(() => {
          inFlight = null;
        });
      const value = await inFlight;
      cache = { value, at: now() };
      return value;
    };
  };
  const claude = cached('claude', async () => parseClaudeUsage(await runClaudeUsage(), now()));
  const cursor = cached(
    'cursor',
    async () => {
      // `about` is quick and shows the sign-in; the meters need the terminal UI.
      const about = parseCursorAbout(await runCursorAbout(), now());
      if (!about.plan) return about;
      try {
        const usage = parseCursorUsage(await runCursorUsage(), now());
        return usage.windows.length > 0 ? usage : about;
      } catch {
        return about;
      }
    },
    CURSOR_PROBE_TTL_MS
  );
  const codex = cached('codex', async () => {
    try {
      return parseCodexRateLimits(await readCodexRateLimits(env), now());
    } catch {
      return readCodexUsage(env, now());
    }
  });
  const accountProbes = new Map<string, (refresh: boolean) => Promise<AgentUsage>>();
  const accountProbe = (account: OfficialAccount) => {
    const agent = account.account.agent;
    let probe = accountProbes.get(`${agent}:${account.id}`);
    if (!probe) {
      probe = cached(agent, async () => {
        const home = await deps.accountHome!(account);
        const accountEnv = {
          home: env.home,
          env: { ...env.env, [ACCOUNT_HOME_ENV[agent]]: home },
        };
        return agent === 'claude'
          ? parseClaudeUsage(await runClaudeUsageCommand(accountEnv), now())
          : parseCodexRateLimits(await readCodexRateLimits(accountEnv), now());
      });
      accountProbes.set(`${agent}:${account.id}`, probe);
    }
    return probe;
  };

  return {
    async get(options = {}): Promise<UsageLimits> {
      const refresh = options.refresh === true;
      const [claudeUsage, codexUsage, cursorUsage] = await Promise.all([
        claude(refresh),
        codex(refresh),
        cursor(refresh),
      ]);
      return { agents: [claudeUsage, codexUsage, cursorUsage] };
    },
    async accounts(options = {}): Promise<AgentUsage[]> {
      if (!deps.listAccounts || !deps.accountHome) return [];
      const accounts = await deps.listAccounts();
      return Promise.all(
        accounts.map(async (account) => ({
          ...(await accountProbe(account)(options.refresh === true)),
          account: { id: account.id, name: account.name },
        }))
      );
    },
  };
}

// ── Claude ───────────────────────────────────────────────────────────────────

const CLAUDE_LINE =
  /^Current (session|week(?: \(([^)]+)\))?): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/;

/** Parses the `/usage` text; absent limit lines mean the account has none to show. */
export function parseClaudeUsage(text: string, observedAt: number): AgentUsage {
  const windows: UsageWindow[] = [];
  for (const line of text.split('\n')) {
    const match = CLAUDE_LINE.exec(line.trim());
    if (!match) continue;
    const [, kind, scope, percent, resets] = match;
    const label =
      kind === 'session' ? '5h' : !scope || scope === 'all models' ? 'Week' : `Week · ${scope}`;
    windows.push({ label, usedPercent: Number(percent), resets: resets?.trim() ?? null });
  }
  if (windows.length === 0) {
    const firstLine =
      text
        .split('\n')
        .find((line) => line.trim())
        ?.trim() ?? '';
    // Without a subscription sign-in, /usage only prints the session's cost.
    const reason = /^Total cost/i.test(firstLine)
      ? 'Not signed in with a Claude subscription'
      : firstLine || 'No subscription limits reported';
    return unavailable('claude', observedAt, reason);
  }
  const plan = /subscription/i.test(text) ? 'subscription' : null;
  return { agent: 'claude', plan, windows, observedAt };
}

async function runClaudeUsageCommand(env: Env): Promise<string> {
  const claudePath = await findExecutable('claude', env);
  if (!claudePath) throw new Error('Claude Code CLI not found');
  // A scratch cwd, and no persistence, so the probe never shows up as a session anywhere.
  const cwd = path.join(os.tmpdir(), 'emdash-usage-probe');
  await mkdir(cwd, { recursive: true });
  const { stdout } = await execFileAsync(
    claudePath,
    ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
    { cwd, env: env.env, timeout: 45_000, maxBuffer: 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout) as { result?: unknown; is_error?: unknown };
  if (parsed.is_error === true || typeof parsed.result !== 'string') {
    throw new Error(typeof parsed.result === 'string' ? parsed.result : '/usage failed');
  }
  return parsed.result;
}

async function findExecutable(name: string, { home, env }: Env): Promise<string | null> {
  const dirs = [
    ...(env.PATH ?? '').split(':').filter(Boolean),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export const CURSOR_USAGE_URL = 'https://cursor.com/dashboard?tab=usage';

/** The plan from `cursor-agent about`, with the usage dashboard for the numbers. */
export function parseCursorAbout(stdout: string, observedAt: number): AgentUsage {
  const about = JSON.parse(stdout) as { subscriptionTier?: unknown };
  const plan = typeof about.subscriptionTier === 'string' ? about.subscriptionTier : null;
  return { agent: 'cursor', plan, windows: [], observedAt, detailsUrl: CURSOR_USAGE_URL };
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?/g;
const CURSOR_METERS: Record<string, string> = { Auto: 'Auto', API: 'API', Included: 'Month' };

/**
 * The meters Cursor's `/usage` shows: the included usage of the month, split into Auto
 * (Cursor's own models: Grok, Composer) and API (other vendors' models), and when they
 * reset. Read from the last time the panel was drawn.
 *
 *   Usage • Pro+                                   Resets Nov 1
 *   Included        12% used          ░░░░
 *     Auto          20% used          ░░░░
 *     API           3% used           ░░░░
 */
export function parseCursorUsage(screen: string, observedAt: number): AgentUsage {
  const text = screen.replace(ANSI, '');
  const start = text.lastIndexOf('Usage •');
  if (start < 0) throw new Error('Cursor did not show its usage');
  const panel = text.slice(start).split(/\r?\n/);
  const header = /^Usage • (.+?)(?:\s{2,}Resets (.+?))?\s*$/.exec(panel[0]!.trim());
  const plan = header?.[1]?.trim() || null;
  const resets = header?.[2]?.trim() || null;
  const windows: UsageWindow[] = [];
  for (const line of panel) {
    const match = /^\s*(Auto|API|Included)\s+(\d+(?:\.\d+)?)% used/.exec(line);
    const label = match && CURSOR_METERS[match[1]!];
    if (!label || windows.some((window) => window.label === label)) continue;
    windows.push({ label, usedPercent: Number(match[2]), resets });
  }
  // Auto and API first: they are the two pools, and the sidebar shows the first two.
  windows.sort((a, b) => Number(a.label === 'Month') - Number(b.label === 'Month'));
  return { agent: 'cursor', plan, windows, observedAt, detailsUrl: CURSOR_USAGE_URL };
}

/**
 * Opens Cursor's terminal UI in a hidden terminal, runs its `/usage` (which calls no
 * model) and returns what it drew. Cursor offers its usage nowhere else but a private
 * API; this reads it the way the user would. The empty chat Cursor records for the
 * scratch folder is removed afterwards.
 */
async function runCursorUsageCommand(env: Env): Promise<string> {
  const cursorPath =
    (await findExecutable('cursor-agent', env)) ?? (await findExecutable('agent', env));
  if (!cursorPath) throw new Error('Cursor CLI not found');
  const cwd = path.join(os.tmpdir(), 'emdash-usage-probe');
  await mkdir(cwd, { recursive: true });
  try {
    return await driveCursorUsage(cursorPath, cwd, env);
  } finally {
    // Cursor keeps chats in ~/.cursor/chats/<md5 of the folder>.
    const folder = await realpath(cwd).catch(() => cwd);
    const chats = path.join(env.home, '.cursor', 'chats');
    const hash = createHash('md5').update(folder).digest('hex');
    await rm(path.join(chats, hash), { recursive: true, force: true });
  }
}

const CURSOR_PROBE_TIMEOUT_MS = 30_000;

function driveCursorUsage(cursorPath: string, cwd: string, env: Env): Promise<string> {
  return new Promise((resolve, reject) => {
    const pty = nodePty.spawn(cursorPath, ['--trust'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 50,
      cwd,
      env: buildTerminalEnv({ baseEnv: env.env }),
    });
    let output = '';
    let stage: 'starting' | 'asked' | 'done' = 'starting';
    let quiet: NodeJS.Timeout | undefined;
    const finish = (error: Error | null) => {
      if (stage === 'done') return;
      stage = 'done';
      clearTimeout(quiet);
      clearTimeout(deadline);
      pty.kill();
      if (error) reject(error);
      else resolve(output);
    };
    const deadline = setTimeout(
      () => finish(new Error('Cursor did not show its usage in time')),
      CURSOR_PROBE_TIMEOUT_MS
    );
    pty.onData((data) => {
      output += data;
      // Answer what a terminal would, or the UI waits: cursor position, device
      // attributes, colors.
      if (data.includes('\x1b[6n')) pty.write('\x1b[1;1R');
      if (data.includes('\x1b[c')) pty.write('\x1b[?1;2c');
      if (data.includes('\x1b]11;?')) pty.write('\x1b]11;rgb:0000/0000/0000\x07');
      if (data.includes('\x1b]10;?')) pty.write('\x1b]10;rgb:ffff/ffff/ffff\x07');
      if (stage === 'starting') {
        // Ready once it has drawn and gone quiet.
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          stage = 'asked';
          pty.write('/usage');
          setTimeout(() => pty.write('\r'), 500);
        }, 1_500);
      } else if (stage === 'asked' && /Usage •[\s\S]*Esc to close/.test(output.replace(ANSI, ''))) {
        finish(null);
      }
    });
    pty.onExit(() => finish(new Error('Cursor exited before showing its usage')));
  });
}

async function runCursorAboutCommand(env: Env): Promise<string> {
  const cursorPath =
    (await findExecutable('cursor-agent', env)) ?? (await findExecutable('agent', env));
  if (!cursorPath) throw new Error('Cursor CLI not found');
  const { stdout } = await execFileAsync(cursorPath, ['about', '--format', 'json'], {
    env: env.env,
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  return stdout;
}

// ── Codex ────────────────────────────────────────────────────────────────────

type CodexWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };

export async function readCodexUsage(env: Env, now: number): Promise<AgentUsage> {
  const codexHome = env.env.CODEX_HOME ?? path.join(env.home, '.codex');
  const files = await newestFiles(path.join(codexHome, 'sessions'), 5);
  for (const file of files) {
    const limits = await lastRateLimits(file.path);
    if (!limits) continue;
    const windows = [limits.primary, limits.secondary]
      .map((window) => codexWindow(window as CodexWindow | undefined, now))
      .filter((window): window is UsageWindow => window !== null);
    if (windows.length === 0) continue;
    return {
      agent: 'codex',
      plan: typeof limits.plan_type === 'string' ? limits.plan_type : null,
      windows,
      observedAt: file.mtimeMs,
    };
  }
  return unavailable('codex', now, 'No Codex usage recorded yet');
}

function codexWindow(window: CodexWindow | undefined, now: number): UsageWindow | null {
  if (!window || typeof window.used_percent !== 'number') return null;
  const minutes = typeof window.window_minutes === 'number' ? window.window_minutes : null;
  const resetsAtMs = typeof window.resets_at === 'number' ? window.resets_at * 1000 : null;
  const label =
    minutes === 300
      ? '5h'
      : minutes === 10080
        ? 'Week'
        : minutes
          ? `${Math.round(minutes / 60)}h`
          : '—';
  // Recorded before its window reset: nothing of it is used any more.
  const reset = resetsAtMs !== null && resetsAtMs <= now;
  return {
    label,
    usedPercent: reset ? 0 : window.used_percent,
    resets: resetsAtMs === null || reset ? null : formatResetTime(resetsAtMs, now),
  };
}

/** The app server's `account/rateLimits/read` result, as usage. */
export function parseCodexRateLimits(result: Record<string, unknown>, now: number): AgentUsage {
  const limits = (result.rateLimits ?? {}) as Record<string, unknown>;
  const window = (value: unknown): UsageWindow | null => {
    const w = value as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
    return w
      ? codexWindow(
          {
            used_percent: w.usedPercent,
            window_minutes: w.windowDurationMins,
            resets_at: w.resetsAt,
          },
          now
        )
      : null;
  };
  const windows = [limits.primary, limits.secondary]
    .map(window)
    .filter((w): w is UsageWindow => w !== null);
  if (windows.length === 0) return unavailable('codex', now, 'No rate limits reported');
  return {
    agent: 'codex',
    plan: typeof limits.planType === 'string' ? limits.planType : null,
    windows,
    observedAt: now,
  };
}

/**
 * Starts `codex app-server` (the same server the chat adapter runs), initializes, and
 * reads the signed-in account's rate limits; the server exits when stdin closes.
 */
async function readCodexRateLimitsCommand(env: Env): Promise<Record<string, unknown>> {
  const codexPath = await findExecutable('codex', env);
  if (!codexPath) throw new Error('Codex CLI not found');
  return new Promise((resolve, reject) => {
    const child = spawn(codexPath, ['app-server'], {
      env: env.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let done = false;
    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Codex did not answer')), 20_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2) {
          if (message.error) finish(new Error(String(message.error.message ?? 'Codex error')));
          else finish(null, (message.result ?? {}) as Record<string, unknown>);
        }
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', () => finish(new Error('Codex exited before answering')));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'emdash', version: '1' } } });
  });
}

async function lastRateLimits(file: string): Promise<Record<string, unknown> | null> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (!line.includes('"rate_limits"')) continue;
      try {
        const record = JSON.parse(line) as { payload?: { rate_limits?: unknown } };
        const limits = record.payload?.rate_limits;
        if (limits && typeof limits === 'object') return limits as Record<string, unknown>;
      } catch {
        // Partial line at the buffer edge.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function newestFiles(
  dir: string,
  count: number
): Promise<{ path: string; mtimeMs: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map(async (entry) => {
        const file = path.join(dir, entry);
        return { path: file, mtimeMs: (await stat(file)).mtimeMs };
      })
  );
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "04:10" when it resets today, else "Oct 2 23:10", in the local time zone. */
export function formatResetTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (new Date(nowMs).toDateString() === at.toDateString()) return time;
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function unavailable(agent: AgentUsage['agent'], observedAt: number, reason: string): AgentUsage {
  return { agent, plan: null, windows: [], observedAt, unavailable: reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
