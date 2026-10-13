import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../api';
import {
  createProviderTransfer,
  parseProviderExport,
  PROVIDER_EXPORT_FORMAT,
} from './provider-transfer';

const api = (id: string, models: string[] = ['m1']): ModelProvider => ({
  id,
  name: id.toUpperCase(),
  protocol: 'openai-responses',
  baseUrl: `https://${id}.example/v1`,
  models,
});
const account: ModelProvider = {
  id: 'work',
  name: 'Work',
  baseUrl: '',
  models: [],
  account: { agent: 'claude' },
};

function setup(initial: ModelProvider[], keys: Record<string, string>) {
  const state = { providers: initial, keys: { ...keys }, files: new Map<string, string>() };
  const modes = new Map<string, number>();
  const transfer = createProviderTransfer({
    getProviders: async () => state.providers,
    saveProviders: async (providers) => {
      state.providers = providers;
    },
    keys: {
      read: async (id) => state.keys[id] ?? null,
      set: async (id, key) => {
        state.keys[id] = key;
      },
      clear: async (id) => {
        delete state.keys[id];
      },
    },
    pickExportPath: async () => '/out.json',
    pickImportPath: async () => '/in.json',
    readText: async (file) => state.files.get(file) ?? '',
    writeText: async (file, text, mode) => {
      state.files.set(file, text);
      modes.set(file, mode);
    },
  });
  return { state, modes, transfer };
}

describe('provider transfer', () => {
  it('exports only the chosen API providers, with keys only when asked', async () => {
    const { state, modes, transfer } = setup([api('a'), api('b'), account], { a: 'sk-a' });
    await transfer.exportProviders({ providerIds: ['a', 'work'], includeKeys: false });
    const plain = JSON.parse(state.files.get('/out.json')!);
    expect(plain.providers).toEqual([api('a')]);
    expect(modes.get('/out.json')).toBe(0o644);

    await transfer.exportProviders({ providerIds: ['a', 'b'], includeKeys: true });
    const withKeys = JSON.parse(state.files.get('/out.json')!);
    expect(withKeys.providers.map((p: { apiKey?: string }) => p.apiKey)).toEqual([
      'sk-a',
      undefined,
    ]);
    expect(modes.get('/out.json')).toBe(0o600);
  });

  it('previews without keys, then imports only the chosen ones', async () => {
    const { state, transfer } = setup([api('a', ['old'])], { a: 'sk-old' });
    state.files.set(
      '/in.json',
      JSON.stringify({
        format: PROVIDER_EXPORT_FORMAT,
        version: 1,
        providers: [
          { ...api('a', ['new']), apiKey: 'sk-new' },
          { ...api('b'), apiKey: 'sk-b' },
          api('c'),
        ],
      })
    );
    const preview = await transfer.readImport();
    expect(JSON.stringify(preview)).not.toContain('sk-');
    expect(preview?.providers.map((p) => [p.id, p.hasKey, p.exists])).toEqual([
      ['a', true, true],
      ['b', true, false],
      ['c', false, false],
    ]);

    await transfer.importProviders({
      token: preview!.token,
      providerIds: ['a', 'c'],
      includeKeys: false,
    });
    expect(state.providers.map((p) => [p.id, p.models])).toEqual([
      ['a', ['new']],
      ['c', ['m1']],
    ]);
    expect(state.keys).toEqual({ a: 'sk-old' });
    await expect(
      transfer.importProviders({ token: preview!.token, providerIds: ['b'], includeKeys: true })
    ).rejects.toThrow(/again/);
  });

  it('imports keys when asked', async () => {
    const { state, transfer } = setup([], {});
    state.files.set(
      '/in.json',
      JSON.stringify({
        format: PROVIDER_EXPORT_FORMAT,
        version: 1,
        providers: [{ ...api('b'), apiKey: 'sk-b' }],
      })
    );
    const preview = await transfer.readImport();
    await transfer.importProviders({
      token: preview!.token,
      providerIds: ['b'],
      includeKeys: true,
    });
    expect(state.keys).toEqual({ b: 'sk-b' });
  });

  it('removes a saved key that would go to an address the file chose', async () => {
    const moved = { ...api('a'), baseUrl: 'https://elsewhere.example/v1' };
    const file = (providers: unknown[]) =>
      JSON.stringify({ format: PROVIDER_EXPORT_FORMAT, version: 1, providers });

    const { state, transfer } = setup([api('a'), api('b')], { a: 'sk-a', b: 'sk-b' });
    state.files.set('/in.json', file([moved, { ...api('b'), models: ['m2'] }]));
    let preview = await transfer.readImport();
    expect(preview?.providers.map((p) => p.previousUrl)).toEqual(['https://a.example/v1', null]);
    await transfer.importProviders({
      token: preview!.token,
      providerIds: ['a', 'b'],
      includeKeys: true,
    });
    // Same address: the key stays. New address and no key in the file: the key goes.
    expect(state.keys).toEqual({ b: 'sk-b' });
    expect(state.providers[0]?.baseUrl).toBe('https://elsewhere.example/v1');

    state.keys = { a: 'sk-a' };
    state.providers = [api('a')];
    state.files.set('/in.json', file([{ ...moved, apiKey: 'sk-new' }]));
    preview = await transfer.readImport();
    await transfer.importProviders({
      token: preview!.token,
      providerIds: ['a'],
      includeKeys: true,
    });
    expect(state.keys).toEqual({ a: 'sk-new' });

    state.keys = { a: 'sk-a' };
    state.providers = [api('a')];
    preview = await transfer.readImport();
    await transfer.importProviders({
      token: preview!.token,
      providerIds: ['a'],
      includeKeys: false,
    });
    expect(state.keys).toEqual({});
  });

  it('never replaces an official account with an API provider of its id', async () => {
    const { state, transfer } = setup([account], {});
    state.files.set(
      '/in.json',
      JSON.stringify({
        format: PROVIDER_EXPORT_FORMAT,
        version: 1,
        providers: [api('work'), api('b')],
      })
    );
    const preview = await transfer.readImport();
    expect(preview?.providers.map((p) => p.id)).toEqual(['b']);
    expect(preview?.skipped).toBe(1);
  });

  it('writes a keyed export owner-only, even over a file anyone could read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'provider-export-'));
    try {
      const out = path.join(dir, 'out.json');
      await writeFile(out, 'old', { mode: 0o644 });
      const transfer = createProviderTransfer({
        getProviders: async () => [api('a')],
        saveProviders: async () => {},
        keys: { read: async () => 'sk-a', set: async () => {}, clear: async () => {} },
        pickExportPath: async () => out,
        pickImportPath: async () => undefined,
      });
      await transfer.exportProviders({ providerIds: ['a'], includeKeys: true });
      expect(JSON.parse(await readFile(out, 'utf8')).providers[0].apiKey).toBe('sk-a');
      if (process.platform !== 'win32') expect((await stat(out)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips official accounts, duplicates and invalid entries, and rejects other files', () => {
    const parsed = parseProviderExport(
      JSON.stringify({
        format: PROVIDER_EXPORT_FORMAT,
        version: 1,
        providers: [api('a'), api('a'), account, { id: '' }],
      })
    );
    expect(parsed.entries.map((entry) => entry.provider.id)).toEqual(['a']);
    expect(parsed.skipped).toBe(3);
    expect(() => parseProviderExport('{"providers":[]}')).toThrow(/not an Emdash/);
    expect(() => parseProviderExport('nope')).toThrow(/not a JSON/);
  });
});
