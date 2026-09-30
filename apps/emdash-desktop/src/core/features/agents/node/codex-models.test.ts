import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexModelOptions } from './codex-models';

const builtIn = {
  'gpt-6-sol': { name: '6 Sol', modelFeatures: { intelligence: 5, speed: 4 } },
  'gpt-old': { name: 'Old' },
};

describe('codexModelOptions', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'codex-models-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("follows Codex's cached list, in its order, without hidden models", async () => {
    await mkdir(path.join(home, '.codex'));
    await writeFile(
      path.join(home, '.codex', 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 3 },
          {
            slug: 'gpt-7-nova',
            display_name: 'GPT-7-Nova',
            description: 'Newest.',
            visibility: 'list',
            priority: 1,
            context_window: 400000,
          },
          { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
        ],
      })
    );

    const options = codexModelOptions(builtIn, { home, env: {} });

    expect(Object.keys(options)).toEqual(['gpt-7-nova', 'gpt-6-sol']);
    expect(options['gpt-7-nova']).toEqual({
      name: '7 Nova',
      description: 'Newest.',
      modelFeatures: { contextWindowSize: 400000 },
    });
    expect(options['gpt-6-sol']).toEqual({
      name: '6 Sol',
      modelFeatures: { intelligence: 5, speed: 4 },
    });
  });

  it('keeps the built-in list without a usable cache', async () => {
    expect(codexModelOptions(builtIn, { home, env: {} })).toBe(builtIn);
    await mkdir(path.join(home, '.codex'));
    await writeFile(path.join(home, '.codex', 'models_cache.json'), '{not json');
    expect(codexModelOptions(builtIn, { home, env: {} })).toBe(builtIn);
  });
});
