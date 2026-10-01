import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectDirName } from './external-sessions';
import { createPriceCatalog, parseModelsDev, priceOf, sessionCost } from './session-cost';

const lines = (records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

const MODELS_DEV = {
  openrouter: {
    models: {
      'claude-opus-5-5': { cost: { input: 99, output: 99 } },
      'deepseek/deepseek-v4.1-flash': { cost: { input: 0.2, output: 0.8, cache_read: 0.01 } },
    },
  },
  anthropic: {
    models: {
      'claude-opus-5-5': { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
    },
  },
  openai: {
    models: {
      'gpt-6-sol': {
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          tiers: [
            { input: 4, output: 15, cache_read: 0.4, tier: { type: 'context', size: 272000 } },
          ],
        },
      },
    },
  },
};

describe('prices', () => {
  const catalog = parseModelsDev(MODELS_DEV);

  it("prefers the vendor's own listing and matches agents' model names", () => {
    expect(priceOf(catalog, 'claude-opus-5-5')?.input).toBe(4);
    expect(priceOf(catalog, 'claude-opus-5-5[1m]')?.output).toBe(20);
    expect(priceOf(catalog, 'openai/gpt-6-sol')?.input).toBe(2);
    expect(priceOf(catalog, 'deepseek/deepseek-v4.1-flash')?.cacheRead).toBe(0.01);
    expect(priceOf(catalog, 'gpt-6-sol')?.longContext).toEqual({
      above: 272000,
      input: 4,
      output: 15,
      cacheRead: 0.4,
    });
  });

  it('caches the catalog for offline use and refreshes it daily', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'prices-'));
    const cacheFile = path.join(dir, 'prices.json');
    let now = 0;
    const fetchJson = vi.fn(async () => MODELS_DEV);
    const load = createPriceCatalog({ cacheFile, fetchJson, now: () => now });
    expect((await load()).get('gpt-6-sol')?.output).toBe(10);
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).prices.length).toBeGreaterThan(0);

    const offline = createPriceCatalog({
      cacheFile,
      fetchJson: async () => {
        throw new Error('offline');
      },
      now: () => now,
    });
    expect((await offline()).get('claude-opus-5-5')?.input).toBe(4);
    now = 2 * 24 * 60 * 60_000;
    await load();
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
    await rm(dir, { recursive: true, force: true });
  });
});

describe('sessionCost', () => {
  let home: string;
  const env = () => ({ home, env: {} });
  const catalog = parseModelsDev(MODELS_DEV);

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'session-cost-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function file(relative: string, content: string) {
    const full = path.join(home, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  it("prices Claude's API messages once each, with its Task agents and 1h cache writes", async () => {
    const cwd = path.join(home, 'repo');
    await mkdir(cwd);
    const dir = `.claude/projects/${claudeProjectDirName(cwd)}`;
    const usage = {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 300000,
      cache_creation_input_tokens: 50000,
      cache_creation: { ephemeral_5m_input_tokens: 20000, ephemeral_1h_input_tokens: 30000 },
    };
    const assistant = (id: string) => ({
      type: 'assistant',
      message: { id, model: 'claude-opus-5-5', usage },
    });
    // One response is written as several records sharing its id.
    await file(`${dir}/s1.jsonl`, lines([assistant('m1'), assistant('m1'), { type: 'user' }]));
    await file(`${dir}/s1/subagents/agent-a.jsonl`, lines([assistant('m2')]));

    const cost = await sessionCost('claude', 's1', cwd, catalog, env());
    // (1000*4 + 2000*20 + 300000*0.2 + 20000*5 + 30000*8) / 1e6 = 0.444 per message
    expect(cost?.amount).toBeCloseTo(0.888, 6);
    expect(cost?.tokens).toEqual({
      input: 2000,
      output: 4000,
      cacheRead: 600000,
      cacheWrite: 100000,
    });
  });

  it("estimates Claude's context compactions, which it does not record", async () => {
    const cwd = path.join(home, 'repo');
    await mkdir(cwd);
    const dir = `.claude/projects/${claudeProjectDirName(cwd)}`;
    await file(
      `${dir}/s2.jsonl`,
      lines([
        {
          type: 'assistant',
          message: { id: 'm1', model: 'claude-opus-5-5', usage: { output_tokens: 10 } },
        },
        { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 100000 } },
        // 400 Latin characters ≈ 100 tokens, plus 20 CJK characters ≈ 20.
        {
          type: 'user',
          isCompactSummary: true,
          message: { content: `${'a'.repeat(400)}${'摘'.repeat(20)}` },
        },
      ])
    );

    const cost = await sessionCost('claude', 's2', cwd, catalog, env());
    expect(cost?.compactions).toBe(1);
    expect(cost?.tokens).toEqual({ input: 0, output: 130, cacheRead: 100000, cacheWrite: 0 });
    // 10*20 + (100000*0.2 + 120*20)
    expect(cost?.amount).toBeCloseTo((200 + 20000 + 2400) / 1e6, 9);
  });

  it("prices Codex's running totals per turn, long-context tier included, with spawned agents", async () => {
    const parent = '01a0e339-0000-7000-8000-000000000001';
    const tokenCount = (input: number, cached: number, output: number, context: number) => ({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
          last_token_usage: { input_tokens: context },
        },
      },
    });
    await file(
      `.codex/sessions/2026/09/27/rollout-x-${parent}.jsonl`,
      lines([
        { type: 'session_meta', payload: { id: parent } },
        { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
        tokenCount(100000, 80000, 1000, 100000),
        tokenCount(400000, 380000, 2000, 300000),
      ])
    );
    await file(
      '.codex/sessions/2026/09/27/rollout-y-child.jsonl',
      lines([
        { type: 'session_meta', payload: { id: 'child', parent_thread_id: parent } },
        { type: 'turn_context', payload: { model: 'mystery-model' } },
        tokenCount(1000, 0, 10, 1000),
      ])
    );

    const cost = await sessionCost('codex', parent, '/', catalog, env());
    // Turn 1: 20000*2 + 80000*0.2 + 1000*10; turn 2 (over 272k): 0*4 + 300000*0.4 + 1000*15.
    expect(cost?.amount).toBeCloseTo((40000 + 16000 + 10000 + 120000 + 15000) / 1e6, 6);
    expect(cost?.unpricedModels).toEqual(['mystery-model']);
    expect(cost?.tokens.input).toBe(21000);
  });

  it('prices Pi / Oh My Pi assistant messages by the model they name', async () => {
    await file(
      '.omp/agent/sessions/-repo/2026_x.jsonl',
      lines([
        { type: 'session', id: 'omp-1', cwd: '/repo' },
        {
          type: 'message',
          message: {
            role: 'assistant',
            model: 'deepseek/deepseek-v4.1-flash',
            usage: { input: 10000, output: 1000, cacheRead: 5000, cacheWrite: 0 },
          },
        },
      ])
    );
    const cost = await sessionCost('oh-my-pi', 'omp-1', '/repo', catalog, env());
    expect(cost?.amount).toBeCloseTo((10000 * 0.2 + 1000 * 0.8 + 5000 * 0.01) / 1e6, 9);
  });

  it('knows nothing for agents without usage records, or unknown sessions', async () => {
    expect(await sessionCost('cursor', 'x', '/', catalog, env())).toBeNull();
    expect(await sessionCost('claude', 'missing', home, catalog, env())).toBeNull();
  });
});
