import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUsageLimitsService,
  CURSOR_USAGE_URL,
  parseClaudeUsage,
  parseCursorAbout,
  readCodexUsage,
} from './usage-limits';

const CLAUDE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 41% used · resets Sep 26 at 2:40am (Asia/Shanghai)',
  'Current week (all models): 30% used · resets Oct 1 at 6am (Asia/Shanghai)',
  'Current week (Opus): 12% used · resets Oct 1 at 6am (Asia/Shanghai)',
  '',
  "What's contributing to your limits usage?",
].join('\n');

describe('parseClaudeUsage', () => {
  it('reads the session (5h) and weekly windows from /usage', () => {
    expect(parseClaudeUsage(CLAUDE_TEXT, 1)).toEqual({
      agent: 'claude',
      plan: 'subscription',
      observedAt: 1,
      windows: [
        { label: '5h', usedPercent: 41, resets: 'Sep 26 at 2:40am (Asia/Shanghai)' },
        { label: 'Week', usedPercent: 30, resets: 'Oct 1 at 6am (Asia/Shanghai)' },
        { label: 'Week · Opus', usedPercent: 12, resets: 'Oct 1 at 6am (Asia/Shanghai)' },
      ],
    });
  });

  it('reports why there are no limits (e.g. API key billing)', () => {
    const usage = parseClaudeUsage('You are using an API key; usage limits do not apply.', 1);
    expect(usage.windows).toEqual([]);
    expect(usage.unavailable).toContain('API key');
  });
});

describe('readCodexUsage', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'emdash-usage-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function rollout(name: string, mtimeSec: number, rateLimits: unknown) {
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '25');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'token_count', rate_limits: rateLimits },
        }),
      ].join('\n') + '\n'
    );
    await utimes(file, mtimeSec, mtimeSec);
  }

  it('takes the newest session’s last rate limits and zeroes windows that already reset', async () => {
    const now = 2_000_000_000_000;
    await rollout('old.jsonl', 1_000, {
      primary: { used_percent: 99, window_minutes: 300, resets_at: 9_999_999_999 },
    });
    await rollout('new.jsonl', 2_000, {
      plan_type: 'plus',
      primary: { used_percent: 42, window_minutes: 300, resets_at: now / 1000 + 3600 },
      secondary: { used_percent: 80, window_minutes: 10080, resets_at: now / 1000 - 60 },
    });

    const usage = await readCodexUsage({ home, env: {} }, now);

    expect(usage.plan).toBe('plus');
    expect(usage.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5h', 42],
      ['Week', 0],
    ]);
    expect(usage.windows[0]!.resets).not.toBeNull();
    expect(usage.windows[1]!.resets).toBeNull();
  });

  it('says so when Codex never recorded usage', async () => {
    expect((await readCodexUsage({ home, env: {} }, 1)).unavailable).toBeTruthy();
  });
});

describe('createUsageLimitsService', () => {
  it('caches the Claude probe and re-runs it on refresh', async () => {
    const runClaudeUsage = vi.fn(async () => CLAUDE_TEXT);
    let now = 0;
    const service = createUsageLimitsService({
      env: { home: '/nonexistent', env: {} },
      now: () => now,
      runClaudeUsage,
      runCursorAbout: async () => '{"subscriptionTier":"Pro"}',
    });

    await service.get();
    now = 60_000;
    const cached = await service.get();
    expect(runClaudeUsage).toHaveBeenCalledTimes(1);
    expect(cached.agents.map((a) => a.agent)).toEqual(['claude', 'codex', 'cursor']);

    await service.get({ refresh: true });
    expect(runClaudeUsage).toHaveBeenCalledTimes(2);
  });

  it('turns a failed probe into an unavailable entry', async () => {
    const service = createUsageLimitsService({
      env: { home: '/nonexistent', env: {} },
      runClaudeUsage: async () => {
        throw new Error('Claude Code CLI not found');
      },
      runCursorAbout: async () => {
        throw new Error('Cursor CLI not found');
      },
    });
    const [claude] = (await service.get()).agents;
    expect(claude?.unavailable).toBe('Claude Code CLI not found');
  });
});

describe('parseCursorAbout', () => {
  it('shows the plan and points at the usage dashboard', () => {
    expect(parseCursorAbout('{"subscriptionTier":"Free","model":"Auto"}', 5)).toEqual({
      agent: 'cursor',
      plan: 'Free',
      windows: [],
      observedAt: 5,
      detailsUrl: CURSOR_USAGE_URL,
    });
  });
});
