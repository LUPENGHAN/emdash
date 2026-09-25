import { execFile } from 'node:child_process';
import { access, mkdir, open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentUsage, UsageLimits, UsageLimitsService, UsageWindow } from '../api';

const execFileAsync = promisify(execFile);
const PROBE_TTL_MS = 5 * 60_000;
const CODEX_TAIL_BYTES = 2 * 1024 * 1024;

type Env = { home: string; env: NodeJS.ProcessEnv };

export type UsageLimitsDeps = {
  env?: Env;
  now?: () => number;
  /** Runs `claude -p /usage`; returns its JSON `result` text. */
  runClaudeUsage?: () => Promise<string>;
  /** Runs `cursor-agent about --format json`; returns its stdout. */
  runCursorAbout?: () => Promise<string>;
};

/**
 * Subscription limit usage for the agents whose vendors expose it:
 * - Codex records its rate limits (5h and weekly windows) in every turn's `token_count`
 *   event, so the newest session file has the latest numbers, no network needed.
 * - Claude Code prints them for the local `/usage` command, which calls no model; it is
 *   probed with `claude -p /usage --no-session-persistence` and cached for a while.
 */
export function createUsageLimitsService(deps: UsageLimitsDeps = {}): UsageLimitsService {
  const env = deps.env ?? { home: os.homedir(), env: process.env };
  const now = deps.now ?? Date.now;
  const runClaudeUsage = deps.runClaudeUsage ?? (() => runClaudeUsageCommand(env));
  const runCursorAbout = deps.runCursorAbout ?? (() => runCursorAboutCommand(env));

  // Both probes spawn a CLI (and Claude's asks the vendor), so their results are cached.
  const cached = (agent: 'claude' | 'cursor', read: () => Promise<AgentUsage>) => {
    let cache: { value: AgentUsage; at: number } | null = null;
    let inFlight: Promise<AgentUsage> | null = null;
    return async (refresh: boolean): Promise<AgentUsage> => {
      if (!refresh && cache && now() - cache.at < PROBE_TTL_MS) return cache.value;
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
  const cursor = cached('cursor', async () => parseCursorAbout(await runCursorAbout(), now()));

  return {
    async get(options = {}): Promise<UsageLimits> {
      const refresh = options.refresh === true;
      const [claudeUsage, codexUsage, cursorUsage] = await Promise.all([
        claude(refresh),
        readCodexUsage(env, now()).catch((error) =>
          unavailable('codex', now(), errorMessage(error))
        ),
        cursor(refresh),
      ]);
      return { agents: [claudeUsage, codexUsage, cursorUsage] };
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
    return unavailable('claude', observedAt, firstLine || 'No subscription limits reported');
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

/**
 * Cursor's CLI only shows usage in its interactive `/usage` (via a private dashboard
 * API), and its limits are monthly anyway; `about` gives the plan without a model call,
 * and the dashboard has the numbers.
 */
export function parseCursorAbout(stdout: string, observedAt: number): AgentUsage {
  const about = JSON.parse(stdout) as { subscriptionTier?: unknown };
  const plan = typeof about.subscriptionTier === 'string' ? about.subscriptionTier : null;
  return { agent: 'cursor', plan, windows: [], observedAt, detailsUrl: CURSOR_USAGE_URL };
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
