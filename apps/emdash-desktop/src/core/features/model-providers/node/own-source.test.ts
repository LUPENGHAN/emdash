import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeOwnSource } from './own-source';

describe('describeOwnSource', () => {
  let home: string;
  const env = () => ({ home, env: {} });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'own-source-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function file(relative: string, content: string) {
    const full = path.join(home, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  it('names the OpenCode provider of the default model, or of a model the chat picked', async () => {
    await file(
      '.config/opencode/opencode.json',
      JSON.stringify({
        model: 'teamorouter/deepseek-flash',
        provider: {
          teamorouter: { name: 'TeamoRouter', options: { baseURL: 'https://api.example.cn/v1' } },
          newapi: { name: 'New_API' },
        },
      })
    );
    expect(await describeOwnSource('opencode', undefined, env())).toEqual({
      official: false,
      provider: 'TeamoRouter',
      model: 'deepseek-flash',
    });
    expect(await describeOwnSource('opencode', 'newapi/deepseek/v4-flash', env())).toEqual({
      official: false,
      provider: 'New_API',
      model: 'deepseek/v4-flash',
    });
    // A built-in provider has no entry: its id names it.
    expect(
      (await describeOwnSource('opencode', 'github-copilot/claude-fable-5', env()))?.provider
    ).toBe('github-copilot');
  });

  it('treats Codex on OpenAI as official, even through a custom entry without a base URL', async () => {
    expect(await describeOwnSource('codex', 'gpt-6-sol', env())).toEqual({
      official: true,
      provider: null,
      model: 'gpt-6-sol',
    });
    await file(
      '.codex/config.toml',
      'model_provider = "custom"\nmodel = "gpt-6-sol"\n[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\n'
    );
    expect(await describeOwnSource('codex', undefined, env())).toMatchObject({ official: true });
    await file(
      '.codex/config.toml',
      'model_provider = "relay"\n[model_providers.relay]\nname = "Relay"\nbase_url = "https://relay.example.com/v1"\n'
    );
    expect(await describeOwnSource('codex', undefined, env())).toMatchObject({
      official: false,
      provider: 'Relay',
    });
  });

  it('treats Claude as official unless its settings point elsewhere', async () => {
    expect(await describeOwnSource('claude', undefined, env())).toMatchObject({ official: true });
    await file(
      '.claude/settings.json',
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } })
    );
    expect(await describeOwnSource('claude', undefined, env())).toMatchObject({
      official: false,
      provider: 'api.deepseek.com',
    });
  });

  it('reads the default provider of Pi and Oh My Pi', async () => {
    await file(
      '.pi/agent/settings.json',
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-opus-4-8' })
    );
    expect(await describeOwnSource('pi', undefined, env())).toEqual({
      official: false,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    });
    await file(
      '.omp/agent/config.yml',
      'modelRoles:\n  default: zenmux/deepseek/deepseek-v4.1-flash:max\n'
    );
    expect(await describeOwnSource('oh-my-pi', undefined, env())).toEqual({
      official: false,
      provider: 'zenmux',
      model: 'deepseek/deepseek-v4.1-flash',
    });
  });

  it('says nothing for agents it does not know or configs it cannot read', async () => {
    expect(await describeOwnSource('gemini', undefined, env())).toBeNull();
    expect(await describeOwnSource('opencode', undefined, env())).toBeNull();
    await file('.codex/config.toml', 'not = [valid');
    expect(await describeOwnSource('codex', undefined, env())).toBeNull();
  });
});
