import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { secret } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicBaseUrl,
  openAiBaseUrl,
  sourceOverrideOf,
  usesProviderSource,
  type ModelProvider,
} from '../api';
import { agentProviderFilePath, ensureAgentProviderFile } from './agent-provider-files';
import { createEffectiveAgentConfig } from './effective-agent-config';
import { createModelProviderKeys } from './provider-keys';
import { buildSourceLaunch, PROVIDER_KEY_ENV } from './source-launch';

const provider: ModelProvider = {
  id: 'NewAPI',
  name: 'new-api',
  baseUrl: 'http://127.0.0.1:3000/v1/',
  models: ['moonshotai/kimi-k3', 'z-ai/glm-5.3-flash'],
};

describe('base urls', () => {
  it('normalizes to an OpenAI /v1 base and an Anthropic root', () => {
    expect(openAiBaseUrl('http://h:3000')).toBe('http://h:3000/v1');
    expect(openAiBaseUrl('http://h:3000/v1/')).toBe('http://h:3000/v1');
    expect(anthropicBaseUrl('http://h:3000/v1/')).toBe('http://h:3000');
  });
});

describe('buildSourceLaunch', () => {
  it('points Claude Code at the Anthropic endpoint through env only', () => {
    expect(buildSourceLaunch('claude', provider, 'sk-1', 'z-ai/glm-5.3-flash')).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000',
        ANTHROPIC_AUTH_TOKEN: 'sk-1',
        ANTHROPIC_MODEL: 'z-ai/glm-5.3-flash',
      },
      args: [],
    });
  });

  it('gives Codex both terminal -c overrides and the chat adapter config', () => {
    const launch = buildSourceLaunch('codex', provider, 'sk-1', 'moonshotai/kimi-k3');
    expect(launch.args).toContain('model_provider="emdash-newapi"');
    expect(launch.args).toContain(
      'model_providers.emdash-newapi.base_url="http://127.0.0.1:3000/v1"'
    );
    expect(launch.args).toContain(`model_providers.emdash-newapi.env_key="${PROVIDER_KEY_ENV}"`);
    expect(launch.args).toContain('model="moonshotai/kimi-k3"');
    // extraArgs is split on whitespace, so no argument may contain any.
    expect(launch.args.every((arg) => !/\s/.test(arg))).toBe(true);
    expect(JSON.parse(launch.env.CODEX_CONFIG!)).toMatchObject({
      model_provider: 'emdash-newapi',
      model: 'moonshotai/kimi-k3',
    });
    expect(launch.env[PROVIDER_KEY_ENV]).toBe('sk-1');
    expect(launch.env.CODEX_CONFIG).not.toContain('sk-1');
  });

  it('adds an OpenCode provider inline, with the key referenced from env', () => {
    const launch = buildSourceLaunch('opencode', provider, 'sk-1');
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.provider['emdash-newapi'].options).toEqual({
      baseURL: 'http://127.0.0.1:3000/v1',
      apiKey: `{env:${PROVIDER_KEY_ENV}}`,
    });
    expect(Object.keys(config.provider['emdash-newapi'].models)).toEqual(provider.models);
    expect(config.model).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toContain('sk-1');
  });

  it('selects the provider for Pi / Oh My Pi and describes their file entry', () => {
    const launch = buildSourceLaunch('pi', provider, 'sk-1', 'moonshotai/kimi-k3');
    expect(launch.args).toEqual(['--model', 'emdash-newapi/moonshotai/kimi-k3']);
    expect(launch.file?.entry).toEqual({
      baseUrl: 'http://127.0.0.1:3000/v1',
      api: 'openai-completions',
      apiKey: `$${PROVIDER_KEY_ENV}`,
      models: [{ id: 'moonshotai/kimi-k3' }, { id: 'z-ai/glm-5.3-flash' }],
    });
    expect(buildSourceLaunch('oh-my-pi', provider, 'sk-1').args).toEqual([
      '--provider',
      'emdash-newapi',
    ]);
  });
});

describe('ensureAgentProviderFile', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'emdash-providers-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const env = () => ({ home, env: {} });

  it("upserts Emdash's entry in Pi's models.json and keeps the user's providers", async () => {
    const file = agentProviderFilePath('pi', env());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ providers: { ollama: { baseUrl: 'x' } } }));
    const launch = buildSourceLaunch('pi', provider, 'sk-1');

    await ensureAgentProviderFile(launch.file!, env());
    await ensureAgentProviderFile(launch.file!, env());

    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(written.providers)).toEqual(['ollama', 'emdash-newapi']);
    expect(await readFile(file, 'utf8')).not.toContain('sk-1');
  });

  it("keeps comments in Oh My Pi's models.yml", async () => {
    const file = agentProviderFilePath('oh-my-pi', env());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '# my providers\nproviders:\n  zenmux:\n    baseUrl: https://z\n');

    await ensureAgentProviderFile(buildSourceLaunch('oh-my-pi', provider, 'sk-1').file!, env());

    const written = await readFile(file, 'utf8');
    expect(written).toContain('# my providers');
    expect(written).toContain('zenmux:');
    expect(written).toContain('emdash-newapi:');
    expect(written).not.toContain('sk-1');
  });
});

describe('createEffectiveAgentConfig', () => {
  function resolver(overrides: Partial<Parameters<typeof createEffectiveAgentConfig>[0]> = {}) {
    return createEffectiveAgentConfig({
      getAgentConfig: async () => ({ extraArgs: '--verbose', modelSource: 'NewAPI' }),
      getProviders: async () => [provider],
      getApiKey: async () => 'sk-1',
      ensureProviderFile: vi.fn(async () => {}),
      ...overrides,
    });
  }

  it("merges the source's env and args after the user's own", async () => {
    const config = await resolver()('codex');
    expect(config?.extraArgs?.startsWith('--verbose -c model_provider=')).toBe(true);
    expect(config?.env?.[PROVIDER_KEY_ENV]).toBe('sk-1');
  });

  it("falls back to the agent's own config without a provider or key", async () => {
    const warn = vi.fn();
    expect(await resolver({ getApiKey: async () => null, warn })('claude')).toEqual({
      extraArgs: '--verbose',
      modelSource: 'NewAPI',
    });
    expect(warn).toHaveBeenCalled();
    expect(await resolver({ getProviders: async () => [] })('claude')).toMatchObject({
      extraArgs: '--verbose',
    });
  });

  it('never routes official-only agents through a provider', async () => {
    expect(await resolver()('cursor')).toEqual({ extraArgs: '--verbose', modelSource: 'NewAPI' });
  });

  it('lets a conversation override the default, including back to the own login', async () => {
    const resolve = resolver();
    expect((await resolve('claude', { modelSource: null }))?.env).toBeUndefined();
    expect(
      (await resolve('claude', { modelSource: 'NewAPI', sourceModel: 'm' }))?.env?.ANTHROPIC_MODEL
    ).toBe('m');
  });
});

describe('createModelProviderKeys', () => {
  function memoryStore() {
    const values = new Map<string, string>();
    return {
      getSecret: async (key: string) => (values.has(key) ? secret(values.get(key)!, key) : null),
      setSecret: async (key: string, value: { expose(): string }) => {
        values.set(key, value.expose());
      },
      deleteSecret: async (key: string) => {
        values.delete(key);
      },
    } as never;
  }

  it('stores, reports and clears a key', async () => {
    const keys = createModelProviderKeys(memoryStore());
    expect(await keys.hasKey('p')).toBe(false);
    await keys.set('p', '  sk-1 ');
    expect(await keys.read('p')).toBe('sk-1');
    await keys.clear('p');
    expect(await keys.hasKey('p')).toBe(false);
  });

  it('lists models from /v1/models with the stored key', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ data: [{ id: 'b-model' }, { id: 'a-model' }] })
    );
    const keys = createModelProviderKeys(memoryStore(), fetchImpl as never);
    await keys.set('p', 'sk-1');

    expect(await keys.listModels({ providerId: 'p', baseUrl: 'http://h:3000' })).toEqual([
      'a-model',
      'b-model',
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://h:3000/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-1' },
      })
    );
  });
});

describe('per-conversation source', () => {
  it('follows the agent default unless the conversation chose a source', () => {
    expect(sourceOverrideOf(undefined)).toBeUndefined();
    expect(sourceOverrideOf({ sourceModel: 'm' })).toBeUndefined();
    expect(sourceOverrideOf({ modelSource: null })).toEqual({
      modelSource: null,
      sourceModel: undefined,
    });
    expect(sourceOverrideOf({ modelSource: 'p', sourceModel: 'm' })).toEqual({
      modelSource: 'p',
      sourceModel: 'm',
    });
  });

  it('treats only a provider id as a provider source', () => {
    expect(usesProviderSource({})).toBe(false);
    expect(usesProviderSource({ modelSource: null })).toBe(false);
    expect(usesProviderSource({ modelSource: 'p' })).toBe(true);
  });
});
