import { describe, expect, it } from 'vitest';
import type { PriceCatalog } from '../session-cost';
import type { FileUsage } from './session-records';
import { buildRows, projectFromCwd, type UsageAttribution } from './usage-stats-service';

const catalog: PriceCatalog = new Map([['m1', { input: 1, output: 2 }]]);

const bucket = (day: string, listUsd: number | null) => ({
  day,
  model: 'm1',
  vendor: null,
  requests: 1,
  input: 1_000_000,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  listUsd,
});

const file = (agent: FileUsage['agent'], sessionId: string, days: string[]): FileUsage => ({
  agent,
  sessionId,
  cwd: '/Users/me/emdash/worktrees/Shop-1a2b3c4d/fix-cart',
  buckets: days.map((day) => bucket(day, 1)),
});

const attribution = (overrides: Partial<UsageAttribution> = {}): UsageAttribution => ({
  conversations: new Map(),
  agentDefaults: {},
  providers: [
    { id: 'gw', name: 'My gateway' },
    { id: 'max2', name: 'Second Max', account: { agent: 'claude' } },
  ],
  ...overrides,
});

const rowsOf = (files: FileUsage[], overrides: Partial<Parameters<typeof buildRows>[0]> = {}) =>
  buildRows({
    machine: 'mac',
    files: files.map((usage, index) => ({ path: `/f${index}`, usage })),
    from: '2026-10-01',
    to: '2026-10-31',
    attribution: attribution(),
    pricing: { sources: {}, usdToCny: 7 },
    catalog,
    ...overrides,
  });

describe('usage rows', () => {
  it("bills a gateway per call at its rate, and a subscription's calls nothing more", () => {
    const { rows } = rowsOf(
      [file('claude', 'on-gateway', ['2026-10-02']), file('claude', 'own', ['2026-10-02'])],
      {
        attribution: attribution({
          conversations: new Map([['on-gateway', { modelSource: 'gw', project: 'Shop' }]]),
        }),
        pricing: { sources: { gw: { multiplier: 0.5, currency: 'CNY' } }, usdToCny: 7 },
      }
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'gw',
          billing: 'usage',
          amount: 0.5,
          currency: 'CNY',
          listUsd: 1,
        }),
        expect.objectContaining({
          source: 'own:claude',
          billing: 'subscription',
          amount: null,
          listUsd: 1,
        }),
      ])
    );
  });

  it("uses the agent's default source for an Emdash conversation that named none", () => {
    const { rows } = rowsOf([file('codex', 's', ['2026-10-02'])], {
      attribution: attribution({
        conversations: new Map([['s', { modelSource: undefined, project: null }]]),
        agentDefaults: { codex: 'gw' },
      }),
    });
    expect(rows[0]).toMatchObject({ source: 'gw', billing: 'usage', amount: 1 });
  });

  it('treats an official account as a subscription, and lets pricing override billing', () => {
    const own = rowsOf([file('claude', 's', ['2026-10-02'])], {
      attribution: attribution({
        conversations: new Map([['s', { modelSource: 'max2', project: null }]]),
      }),
    });
    expect(own.rows[0]).toMatchObject({ source: 'max2', billing: 'subscription', amount: null });

    const overridden = rowsOf([file('claude', 's', ['2026-10-02'])], {
      pricing: { sources: { 'own:claude': { billing: 'usage' } }, usdToCny: 7 },
    });
    expect(overridden.rows[0]).toMatchObject({ billing: 'usage', amount: 1 });
  });

  it('keeps to the days asked for and sums the rest into one row', () => {
    const { rows } = rowsOf([
      file('claude', 'a', ['2026-09-30', '2026-10-05']),
      file('claude', 'b', ['2026-10-05']),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-10-05', requests: 2, listUsd: 2, project: 'Shop' });
  });

  it('prices a model learned since it was read, and lists the ones still unknown', () => {
    const later = file('claude', 'a', []);
    later.buckets = [
      bucket('2026-10-02', null),
      { ...bucket('2026-10-02', null), model: 'mystery' },
    ];
    const { rows, unpricedModels } = rowsOf([later]);
    expect(rows.find((row) => row.model === 'm1')?.listUsd).toBe(1);
    expect(unpricedModels).toEqual(['mystery']);
  });

  it('trusts the provider an agent recorded Emdash launching it on', () => {
    const piFile: FileUsage = {
      agent: 'pi',
      sessionId: 'outside',
      cwd: '/w',
      buckets: [{ ...bucket('2026-10-02', 1), vendor: 'emdash-gw' }],
    };
    const { rows } = rowsOf([piFile], {
      attribution: attribution({
        providers: [{ id: 'gw', name: 'My gateway', configId: 'emdash-gw' }],
      }),
    });
    expect(rows[0]).toMatchObject({ source: 'gw', sourceName: 'My gateway', billing: 'usage' });
  });

  it("names projects after Emdash's worktree folders", () => {
    expect(projectFromCwd('/Users/me/emdash/worktrees/AstrLink-65cfaa3d/main')).toBe('AstrLink');
    expect(projectFromCwd('/Users/me/code/timeflow')).toBe('timeflow');
    expect(projectFromCwd(null)).toBe('—');
  });
});
