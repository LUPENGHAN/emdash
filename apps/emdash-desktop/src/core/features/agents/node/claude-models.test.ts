import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeModelOptions } from './claude-models';

const builtIn = {
  'opus[1m]': { name: 'Opus 5.5', modelFeatures: { intelligence: 5, speed: 2 } },
  sonnet: { name: 'Sonnet 5' },
};

describe('claudeModelOptions', () => {
  let home: string;
  const dir = () => path.join(home, '.claude', 'cache', 'model-catalog');
  const catalog = (models: unknown[]) => JSON.stringify({ catalog: { config: { models } } });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'claude-models-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("follows the newest Claude Code catalog's main models, keeping built-in values", async () => {
    await mkdir(dir(), { recursive: true });
    await writeFile(
      path.join(dir(), 'old-account-cc.json'),
      catalog([{ id: 'claude-old', name: 'Old', section: 'main' }])
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(dir(), 'old-account-cc.json'), old, old);
    await writeFile(
      path.join(dir(), 'account-cc.json'),
      catalog([
        { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', description: 'Complex work' },
        { id: 'claude-sonnet-6', name: 'Sonnet 6', section: 'main', description: 'New' },
        { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'overflow' },
      ])
    );
    // The desktop app's catalog is not Claude Code's.
    await writeFile(
      path.join(dir(), 'account-ccd.json'),
      catalog([{ id: 'x', name: 'X', section: 'main' }])
    );

    expect(claudeModelOptions(builtIn, { home, env: {} })).toEqual({
      'opus[1m]': {
        name: 'Opus 5.5',
        description: 'Complex work',
        modelFeatures: { intelligence: 5, speed: 2 },
      },
      'claude-sonnet-6': { name: 'Sonnet 6', description: 'New' },
    });
  });

  it('keeps the built-in list without a catalog', () => {
    expect(claudeModelOptions(builtIn, { home, env: {} })).toBe(builtIn);
  });
});
