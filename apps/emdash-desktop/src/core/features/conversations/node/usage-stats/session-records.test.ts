import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PriceCatalog } from '../session-cost';
import {
  claudeFileUsage,
  codexFileUsage,
  createUsageScanner,
  localDay,
  openCodeUsage,
  piFileUsage,
  type OpenCodeCall,
} from './session-records';

// $1 per million input tokens, $2 per million output: easy sums.
const catalog: PriceCatalog = new Map([['m1', { input: 1, output: 2, cacheRead: 0.1 }]]);
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n');
const at = (day: string) => `${day}T12:00:00`;

describe('session records', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'emdash-usage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts one call per Claude response, by day and model, priced at list prices', async () => {
    const file = path.join(dir, 'claude.jsonl');
    const usage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    await writeFile(
      file,
      lines([
        { type: 'user', sessionId: 's1', cwd: '/w', message: { content: 'x'.repeat(50) } },
        // One response split over two records: counted once.
        {
          type: 'assistant',
          timestamp: at('2026-10-01'),
          sessionId: 's1',
          message: { id: 'a', model: 'm1', usage },
        },
        {
          type: 'assistant',
          timestamp: at('2026-10-01'),
          sessionId: 's1',
          message: { id: 'a', model: 'm1', usage },
        },
        {
          type: 'assistant',
          timestamp: at('2026-10-02'),
          sessionId: 's1',
          message: { id: 'b', model: 'm1', usage },
        },
        {
          type: 'assistant',
          timestamp: at('2026-10-02'),
          message: { id: 'c', model: '<synthetic>', usage },
        },
      ])
    );
    const result = await claudeFileUsage(file, catalog);
    expect(result.sessionId).toBe('s1');
    expect(result.buckets).toEqual([
      expect.objectContaining({ day: '2026-10-01', model: 'm1', requests: 1, listUsd: 2 }),
      expect.objectContaining({ day: '2026-10-02', model: 'm1', requests: 1, listUsd: 2 }),
    ]);
  });

  it("splits Codex's running totals into calls and counts a spawned agent for its parent", async () => {
    const file = path.join(dir, 'rollout.jsonl');
    const total = (input: number, output: number) => ({
      type: 'event_msg',
      timestamp: at('2026-10-03'),
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    });
    await writeFile(
      file,
      lines([
        {
          type: 'session_meta',
          payload: { id: 'child', parent_thread_id: 'parent', cwd: '/w', model_provider: 'openai' },
        },
        { type: 'turn_context', payload: { model: 'm1' } },
        total(1_000_000, 0),
        total(1_000_000, 0), // unchanged: not a call
        total(2_000_000, 1_000_000),
      ])
    );
    const result = await codexFileUsage(file, catalog);
    expect(result.sessionId).toBe('parent');
    expect(result.buckets).toEqual([
      expect.objectContaining({
        day: '2026-10-03',
        requests: 2,
        input: 2_000_000,
        vendor: 'openai',
        listUsd: 4,
      }),
    ]);
  });

  it('keeps the provider Pi names for each call', async () => {
    const file = path.join(dir, 'pi.jsonl');
    const message = (provider: string, input: number) => ({
      type: 'message',
      timestamp: at('2026-10-04'),
      message: {
        role: 'assistant',
        model: 'm1',
        provider,
        usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    await writeFile(
      file,
      lines([
        { type: 'session', id: 'p1', cwd: '/w' },
        message('openrouter', 1_000_000),
        message('anthropic', 1_000_000),
        message('anthropic', 0), // aborted before a call
      ])
    );
    const result = await piFileUsage('pi', file, catalog);
    expect(result.sessionId).toBe('p1');
    expect(result.buckets.map((bucket) => [bucket.vendor, bucket.requests])).toEqual([
      ['openrouter', 1],
      ['anthropic', 1],
    ]);
  });

  it('prices nothing for a model without a known price', async () => {
    const file = path.join(dir, 'claude.jsonl');
    await writeFile(
      file,
      lines([
        {
          type: 'assistant',
          timestamp: at('2026-10-01'),
          message: { id: 'a', model: 'mystery', usage: { input_tokens: 5 } },
        },
      ])
    );
    expect((await claudeFileUsage(file, catalog)).buckets[0]?.listUsd).toBeNull();
  });

  it('reads a file again only when it changed, and forgets removed files', async () => {
    const root = path.join(dir, 'projects');
    await mkdir(root, { recursive: true });
    const file = path.join(root, 'a.jsonl');
    const record = (id: string) =>
      lines([
        {
          type: 'assistant',
          timestamp: at('2026-10-01'),
          message: { id, model: 'm1', usage: { input_tokens: 1 } },
        },
      ]);
    await writeFile(file, record('a'));
    const scanner = createUsageScanner({
      cacheFile: path.join(dir, 'cache.json'),
      roots: async () => [{ agent: 'claude', dir: root }],
      catalog: async () => catalog,
    });
    expect((await scanner.scan())[0]?.usage.buckets[0]?.requests).toBe(1);
    await writeFile(file, `${record('a')}\n${record('b')}`);
    expect((await scanner.scan())[0]?.usage.buckets[0]?.requests).toBe(2);
    await rm(file);
    expect(await scanner.scan()).toEqual([]);
  });

  it("counts OpenCode's calls per session, reasoning as output", async () => {
    const call = (overrides: Partial<OpenCodeCall>): OpenCodeCall => ({
      sessionId: 'ses_1',
      cwd: '/work/repo',
      time: new Date(at('2026-10-01')).getTime(),
      model: 'deepseek/m1',
      provider: 'emdash-newapi',
      input: 1_000_000,
      output: 250_000,
      reasoning: 250_000,
      cacheRead: 0,
      cacheWrite: 0,
      ...overrides,
    });
    const files = openCodeUsage(
      [call({}), call({ input: 0, output: 0, reasoning: 0 }), call({ sessionId: 'ses_2' })],
      catalog
    );
    expect(files.map((file) => file.path)).toEqual(['opencode:ses_1', 'opencode:ses_2']);
    expect(files[0]?.usage).toMatchObject({ agent: 'opencode', sessionId: 'ses_1', cwd: '/work/repo' });
    expect(files[0]?.usage.buckets).toEqual([
      {
        day: '2026-10-01',
        model: 'deepseek/m1',
        vendor: 'emdash-newapi',
        requests: 1, // the empty (aborted) message is no call
        input: 1_000_000,
        output: 500_000,
        cacheRead: 0,
        cacheWrite: 0,
        listUsd: 2,
      },
    ]);
    const scanner = createUsageScanner({
      cacheFile: path.join(dir, 'cache.json'),
      roots: async () => [],
      openCodeCalls: async () => [call({})],
      catalog: async () => catalog,
    });
    expect((await scanner.scan()).map((file) => file.path)).toEqual(['opencode:ses_1']);
  });

  it('names local days', () => {
    expect(localDay('2026-10-07T09:30:00')).toBe('2026-10-07');
    expect(localDay('not a time')).toBeNull();
  });
});
