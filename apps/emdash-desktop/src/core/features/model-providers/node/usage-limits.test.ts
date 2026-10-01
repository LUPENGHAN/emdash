import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUsageLimitsService,
  CURSOR_USAGE_URL,
  parseClaudeUsage,
  parseCodexRateLimits,
  parseCursorAbout,
  parseCursorUsage,
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
      readCodexRateLimits: async () => {
        throw new Error('not signed in');
      },
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
      readCodexRateLimits: async () => {
        throw new Error('not signed in');
      },
    });
    const [claude] = (await service.get()).agents;
    expect(claude?.unavailable).toBe('Claude Code CLI not found');
  });
});

describe('Codex rate limits and official accounts', () => {
  const RATE_LIMITS = {
    rateLimits: {
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 7_200 },
      secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 700_000 },
      planType: 'plus',
    },
  };

  it("reads Codex's usage from its app server", () => {
    expect(parseCodexRateLimits(RATE_LIMITS, 3_600_000)).toMatchObject({
      agent: 'codex',
      plan: 'plus',
      windows: [
        { label: '5h', usedPercent: 3 },
        { label: 'Week', usedPercent: 42 },
      ],
    });
  });

  it('probes each account in its own config dir, only when asked', async () => {
    const runClaude = vi.fn();
    const readCodexRateLimits = vi.fn(async (env: { env: NodeJS.ProcessEnv }) => {
      if (env.env.CODEX_HOME !== '/accounts/codex-alt') throw new Error('not signed in');
      return RATE_LIMITS;
    });
    const service = createUsageLimitsService({
      env: { home: '/nonexistent', env: {} },
      now: () => 3_600_000,
      runClaudeUsage: runClaude,
      runCursorAbout: async () => '{}',
      readCodexRateLimits,
      listAccounts: async () => [
        { id: 'alt', name: 'Alt', baseUrl: '', models: [], account: { agent: 'codex' } },
      ],
      accountHome: async (account) => `/accounts/codex-${account.id}`,
    });

    const [alt] = await service.accounts();
    expect(alt).toMatchObject({
      agent: 'codex',
      plan: 'plus',
      account: { id: 'alt', name: 'Alt' },
    });
    expect(readCodexRateLimits).toHaveBeenCalledTimes(1);
    await service.accounts();
    expect(readCodexRateLimits).toHaveBeenCalledTimes(1);
  });
});

describe('Cursor usage', () => {
  // As drawn by Cursor's terminal UI: colors, cursor moves, a redraw of the panel.
  const SCREEN = [
    '\x1b[2K  Loading usage data...',
    '\x1b[1m Usage • Pro+\x1b[0m                              Resets Nov 1',
    ' Included        0% used             ░░░░',
    '\x1b[2K\x1b[1m Usage • Pro+\x1b[0m                              Resets Nov 1',
    ' Monthly plan and on-demand usage',
    ' Category        Current             Usage',
    ' Included        \x1b[33m12% used\x1b[0m            ░░░░',
    '   Auto          20.5% used          ░░░░',
    '   API           3% used             ░░░░',
    ' On-Demand       Disabled            ————',
    ' Esc to close',
  ].join('\r\n');

  it("reads the month's pools from the last drawing of Cursor's /usage", () => {
    expect(parseCursorUsage(SCREEN, 5)).toEqual({
      agent: 'cursor',
      plan: 'Pro+',
      windows: [
        { label: 'Auto', usedPercent: 20.5, resets: 'Nov 1' },
        { label: 'API', usedPercent: 3, resets: 'Nov 1' },
        { label: 'Month', usedPercent: 12, resets: 'Nov 1' },
      ],
      observedAt: 5,
      detailsUrl: CURSOR_USAGE_URL,
    });
    expect(() => parseCursorUsage('Loading usage data...', 5)).toThrow();
  });

  it('falls back to the plan when the usage probe fails, and skips it when signed out', async () => {
    const runCursorUsage = vi.fn(async () => {
      throw new Error('timed out');
    });
    const service = (about: string) =>
      createUsageLimitsService({
        env: { home: '/nonexistent', env: {} },
        runClaudeUsage: async () => CLAUDE_TEXT,
        runCursorAbout: async () => about,
        runCursorUsage,
        readCodexRateLimits: async () => {
          throw new Error('not signed in');
        },
      });
    const cursorOf = async (about: string) => (await service(about).get()).agents[2];

    expect(await cursorOf('{"subscriptionTier":"Pro+"}')).toMatchObject({
      plan: 'Pro+',
      windows: [],
      detailsUrl: CURSOR_USAGE_URL,
    });
    expect(runCursorUsage).toHaveBeenCalledTimes(1);
    expect(await cursorOf('{}')).toMatchObject({ plan: null });
    expect(runCursorUsage).toHaveBeenCalledTimes(1);
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
