import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { secret } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatContextWindow,
  parseContextWindow,
  anthropicBaseUrl,
  openAiBaseUrl,
  providerEndpoints,
  providerModelsAuth,
  providerModelsUrl,
  providerSupportsAgent,
  sourceOverrideOf,
  usesProviderSource,
  type ModelProvider,
} from '../api';
import { agentProviderFilePath, removeLegacyProviderEntries } from './agent-provider-files';
import { createEffectiveAgentConfig, ModelSourceUnavailableError } from './effective-agent-config';
import { createModelProviderKeys } from './provider-keys';
import {
  AGENT_MODEL_ENV,
  AGENT_PROVIDER_ENV,
  buildSourceLaunch,
  PROVIDER_KEY_ENV,
  type SourceLaunch,
} from './source-launch';

const provider: ModelProvider = {
  id: 'NewAPI',
  name: 'new-api',
  baseUrl: 'http://127.0.0.1:3000/v1/',
  models: ['moonshotai/kimi-k3', 'z-ai/glm-5.3-flash'],
};

/** The provider config a Pi / Oh My Pi launch hands Emdash's extension. */
function piProvider(launch: SourceLaunch | null) {
  return JSON.parse(launch!.env[AGENT_PROVIDER_ENV]!);
}

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
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'z-ai/glm-5.3-flash',
        ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-5.3-flash',
      },
      args: [],
    });
    // Claude models keep Claude Code's own aliases.
    expect(buildSourceLaunch('claude', provider, 'sk-1', 'claude-opus-5-5')?.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000',
      ANTHROPIC_AUTH_TOKEN: 'sk-1',
      ANTHROPIC_MODEL: 'claude-opus-5-5',
    });
  });

  it('sizes Claude Code gateway models: [1m] for a 1M window, else the unknown-model window', () => {
    const sized = {
      ...provider,
      contextWindows: { 'z-ai/glm-5.3-flash': 1_000_000, 'moonshotai/kimi-k3': 256_000 },
    };
    const million = buildSourceLaunch('claude', sized, 'sk-1', 'z-ai/glm-5.3-flash')!.env;
    expect(million.ANTHROPIC_MODEL).toBe('z-ai/glm-5.3-flash[1m]');
    expect(million.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('z-ai/glm-5.3-flash[1m]');
    expect(million.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();

    const smaller = buildSourceLaunch('claude', sized, 'sk-1', 'moonshotai/kimi-k3')!.env;
    expect(smaller.ANTHROPIC_MODEL).toBe('moonshotai/kimi-k3');
    expect(smaller.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('256000');
  });

  it("points each Claude Code alias, subagents, and the default at the provider's models", () => {
    const roles: ModelProvider = {
      ...provider,
      models: ['claude-opus-4-8', 'claude-sonnet-4-5', 'glm-5', 'kimi-k3'],
      contextWindows: { 'claude-opus-4-8': 1_000_000 },
      claude: {
        model: 'claude-opus-4-8',
        opus: 'claude-opus-4-8',
        sonnet: 'claude-sonnet-4-5',
        haiku: 'glm-5',
        subagent: 'kimi-k3',
        names: { opus: 'Opus (gateway)', haiku: ' ', fable: 'unused' },
      },
    };
    expect(buildSourceLaunch('claude', roles, 'sk-1')!.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000',
      ANTHROPIC_AUTH_TOKEN: 'sk-1',
      ANTHROPIC_MODEL: 'claude-opus-4-8[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Opus (gateway)',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-5',
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3',
    });
    // The conversation's own pick wins over the provider's default; unset aliases follow it.
    const picked = buildSourceLaunch('claude', roles, 'sk-1', 'kimi-k3')!.env;
    expect(picked.ANTHROPIC_MODEL).toBe('kimi-k3');
    expect(picked.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-8[1m]');
    expect(picked.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('kimi-k3');
  });

  it('uses x-api-key for Anthropic’s own API and keeps agents to suitable protocols', () => {
    const anthropicApi: ModelProvider = {
      id: 'a',
      name: 'Anthropic API',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/',
      models: [],
    };
    expect(buildSourceLaunch('claude', anthropicApi, 'sk-ant')?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
    expect(buildSourceLaunch('codex', anthropicApi, 'sk-ant')).toBeNull();
    const opencode = JSON.parse(
      buildSourceLaunch('opencode', anthropicApi, 'sk-ant')!.env.OPENCODE_CONFIG_CONTENT!
    );
    expect(opencode.provider['emdash-a']).toMatchObject({
      npm: '@ai-sdk/anthropic',
      options: { baseURL: 'https://api.anthropic.com/v1' },
    });
    expect(piProvider(buildSourceLaunch('pi', anthropicApi, 'sk-ant'))).toMatchObject({
      baseUrl: 'https://api.anthropic.com',
      api: 'anthropic-messages',
    });
    expect(providerModelsUrl(anthropicApi)).toBe('https://api.anthropic.com/v1/models');
    expect(providerModelsAuth(anthropicApi)).toBe('anthropic-api-key');
  });

  it('keeps an OpenAI base path as typed and picks the chat or Responses API', () => {
    const glm: ModelProvider = {
      id: 'glm',
      name: 'GLM',
      protocol: 'openai-chat',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      models: ['glm-4.6'],
    };
    expect(providerEndpoints(glm)).toEqual({
      openai: { url: 'https://open.bigmodel.cn/api/paas/v4', api: 'chat' },
    });
    expect(providerEndpoints({ protocol: 'openai-chat', baseUrl: 'https://h.example' })).toEqual({
      openai: { url: 'https://h.example/v1', api: 'chat' },
    });
    expect(buildSourceLaunch('claude', glm, 'k')).toBeNull();
    expect(buildSourceLaunch('codex', glm, 'k')).toBeNull();
    expect(providerSupportsAgent(glm, 'codex')).toEqual({
      ok: false,
      reason: 'needs OpenAI Responses',
    });
    expect(piProvider(buildSourceLaunch('pi', glm, 'k'))).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      api: 'openai-completions',
    });
    expect(providerModelsUrl(glm)).toBe('https://open.bigmodel.cn/api/paas/v4/models');
    expect(providerModelsUrl({ ...glm, modelsUrl: 'https://x/models' })).toBe('https://x/models');

    const responses: ModelProvider = { ...glm, protocol: 'openai-responses' };
    expect(providerSupportsAgent(responses, 'codex')).toEqual({ ok: true });
    expect(piProvider(buildSourceLaunch('pi', responses, 'k')).api).toBe('openai-responses');
    expect(
      JSON.parse(buildSourceLaunch('opencode', responses, 'k')!.env.OPENCODE_CONFIG_CONTENT!)
        .provider['emdash-glm'].npm
    ).toBe('@ai-sdk/openai');
  });

  it('gives Codex both terminal -c overrides and the chat adapter config', () => {
    const launch = buildSourceLaunch('codex', provider, 'sk-1', 'moonshotai/kimi-k3')!;
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
    // The chat adapter signs in to the provider itself instead of asking for ChatGPT,
    // and never logs that sign-in.
    expect(JSON.parse(launch.env.DEFAULT_AUTH_REQUEST!)).toEqual({
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: 'http://127.0.0.1:3000/v1',
          providerName: provider.name,
          headers: { Authorization: 'Bearer sk-1' },
        },
      },
    });
    expect(launch.env.APP_SERVER_LOGS).toBe('');
  });

  it("gives Codex the model's context window when the provider sets one", () => {
    const sized = { ...provider, contextWindows: { 'moonshotai/kimi-k3': 1_000_000 } };
    const launch = buildSourceLaunch('codex', sized, 'sk-1', 'moonshotai/kimi-k3')!;
    expect(launch.args).toContain('model_context_window=1000000');
    expect(JSON.parse(launch.env.CODEX_CONFIG!).model_context_window).toBe(1_000_000);
    // Codex caps the context at its metadata's maximum, so a catalog comes with it.
    expect(launch.codexCatalog).toEqual({
      providerKey: 'emdash-newapi',
      models: [{ id: 'moonshotai/kimi-k3', contextWindow: 1_000_000 }],
    });
    const catalogArg = launch.args.find((arg) => arg.startsWith('model_catalog_json='));
    expect(catalogArg).toMatch(/emdash-model-catalog-emdash-newapi\.json"$/);
    expect(JSON.parse(launch.env.CODEX_CONFIG!).model_catalog_json).toBe(
      JSON.parse(catalogArg!.slice('model_catalog_json='.length))
    );
    // The chat UI's Codex reads it at startup, through the wrapper.
    if (process.platform !== 'win32') {
      expect(launch.env.CODEX_PATH).toMatch(/emdash-codex-app-server\.sh$/);
      expect(launch.env.EMDASH_CODEX_MODEL_CATALOG).toBe(
        JSON.parse(catalogArg!.slice('model_catalog_json='.length))
      );
    }
    // Another model of the same provider keeps Codex's own default.
    const other = buildSourceLaunch('codex', sized, 'sk-1', 'x-ai/grok-4.7')!;
    expect(other.args.join(' ')).not.toContain('model_context_window');
    expect(JSON.parse(other.env.CODEX_CONFIG!).model_context_window).toBeUndefined();
    expect(other.codexCatalog).toBeUndefined();
    expect(other.env.CODEX_PATH).toBeUndefined();
  });

  it('reads and writes context windows the way people type them', () => {
    expect(parseContextWindow('1m')).toBe(1_000_000);
    expect(parseContextWindow(' 256K ')).toBe(256_000);
    expect(parseContextWindow('1.5M')).toBe(1_500_000);
    expect(parseContextWindow('131072')).toBe(131_072);
    for (const bad of ['', 'abc', '0', '-1', '1g']) expect(parseContextWindow(bad)).toBeNull();
    expect(formatContextWindow(1_000_000)).toBe('1m');
    expect(formatContextWindow(256_000)).toBe('256k');
    expect(formatContextWindow(131_072)).toBe('131072');
  });

  it('adds an OpenCode provider inline, with the key referenced from env', () => {
    const launch = buildSourceLaunch('opencode', provider, 'sk-1')!;
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.provider['emdash-newapi'].options).toEqual({
      baseURL: 'http://127.0.0.1:3000/v1',
      apiKey: `{env:${PROVIDER_KEY_ENV}}`,
    });
    expect(Object.keys(config.provider['emdash-newapi'].models)).toEqual(provider.models);
    expect(config.model).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toContain('sk-1');
  });

  it('passes configured context windows to OpenCode models', () => {
    const sized = { ...provider, contextWindows: { 'moonshotai/kimi-k3': 1_000_000 } };
    const config = JSON.parse(
      buildSourceLaunch('opencode', sized, 'sk-1')!.env.OPENCODE_CONFIG_CONTENT!
    );

    expect(config.provider['emdash-newapi'].models).toEqual({
      'moonshotai/kimi-k3': { name: 'moonshotai/kimi-k3', limit: { context: 1_000_000 } },
      'z-ai/glm-5.3-flash': { name: 'z-ai/glm-5.3-flash' },
    });
  });

  it('hands Pi / Oh My Pi the provider through env only, for their Emdash extension', () => {
    const launch = buildSourceLaunch('pi', provider, 'sk-1', 'moonshotai/kimi-k3')!;
    expect(launch.args).toEqual(['--model', 'emdash-newapi/moonshotai/kimi-k3']);
    expect(launch.extensionAgent).toBe('pi');
    expect(launch.env[AGENT_MODEL_ENV]).toBe('emdash-newapi/moonshotai/kimi-k3');
    expect(piProvider(launch)).toEqual({
      key: 'emdash-newapi',
      name: 'new-api',
      baseUrl: 'http://127.0.0.1:3000/v1',
      api: 'openai-completions',
      apiKey: `$${PROVIDER_KEY_ENV}`,
      models: [
        { id: 'moonshotai/kimi-k3', reasoning: true },
        { id: 'z-ai/glm-5.3-flash', reasoning: true },
      ],
    });
    expect(launch.env[AGENT_PROVIDER_ENV]).not.toContain('sk-1');
    const ompLaunch = buildSourceLaunch('oh-my-pi', provider, 'sk-1')!;
    expect(ompLaunch.args).toEqual(['--provider', 'emdash-newapi']);
    expect(piProvider(ompLaunch).apiKey).toBe(PROVIDER_KEY_ENV);
  });

  it('passes context windows and reasoning (on unless turned off) to Pi and Oh My Pi models', () => {
    const sized = {
      ...provider,
      contextWindows: { 'moonshotai/kimi-k3': 1_000_000 },
      nonReasoningModels: ['z-ai/glm-5.3-flash'],
    };

    for (const agent of ['pi', 'oh-my-pi'] as const) {
      expect(piProvider(buildSourceLaunch(agent, sized, 'sk-1')).models).toEqual([
        { id: 'moonshotai/kimi-k3', reasoning: true, contextWindow: 1_000_000 },
        { id: 'z-ai/glm-5.3-flash', reasoning: false },
      ]);
    }
  });
});

describe('removeLegacyProviderEntries', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'emdash-providers-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const env = () => ({ home, env: {} });
  const ours = { baseUrl: 'http://h/v1', api: 'openai-completions', models: [] };

  it("drops only Emdash's entries from Pi's models.json", async () => {
    const file = agentProviderFilePath('pi', env());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        providers: {
          ollama: { baseUrl: 'x' },
          'emdash-newapi': { ...ours, apiKey: `$${PROVIDER_KEY_ENV}` },
          'emdash-mine': { baseUrl: 'y', apiKey: 'MY_KEY' },
        },
      })
    );

    await removeLegacyProviderEntries('pi', env());

    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(written.providers)).toEqual(['ollama', 'emdash-mine']);
  });

  it("keeps comments in Oh My Pi's models.yml, and removes a file only Emdash wrote", async () => {
    const file = agentProviderFilePath('oh-my-pi', env());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `# my providers\nproviders:\n  zenmux:\n    baseUrl: https://z\n  emdash-newapi:\n    baseUrl: http://h/v1\n    apiKey: ${PROVIDER_KEY_ENV}\n`
    );
    await removeLegacyProviderEntries('oh-my-pi', env());
    const written = await readFile(file, 'utf8');
    expect(written).toContain('# my providers');
    expect(written).toContain('zenmux:');
    expect(written).not.toContain('emdash-newapi');

    await writeFile(file, `providers:\n  emdash-newapi:\n    apiKey: $${PROVIDER_KEY_ENV}\n`);
    await removeLegacyProviderEntries('oh-my-pi', env());
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('leaves files without Emdash entries untouched', async () => {
    const file = agentProviderFilePath('pi', env());
    await mkdir(path.dirname(file), { recursive: true });
    const content = '{"providers":{"ollama":{"baseUrl":"x"}}}';
    await writeFile(file, content);
    await removeLegacyProviderEntries('pi', env());
    expect(await readFile(file, 'utf8')).toBe(content);
  });
});

describe('createEffectiveAgentConfig', () => {
  function resolver(overrides: Partial<Parameters<typeof createEffectiveAgentConfig>[0]> = {}) {
    return createEffectiveAgentConfig({
      getAgentConfig: async () => ({ extraArgs: '--verbose', modelSource: 'NewAPI' }),
      getProviders: async () => [provider],
      getApiKey: async () => 'sk-1',
      prepareAgentProvider: vi.fn(async () => {}),
      prepareAccountHome: vi.fn(async () => '/accounts/claude-work'),
      ...overrides,
    });
  }

  it("merges the source's env and args after the user's own", async () => {
    const config = await resolver()('codex');
    expect(config?.extraArgs?.startsWith('--verbose -c model_provider=')).toBe(true);
    expect(config?.env?.[PROVIDER_KEY_ENV]).toBe('sk-1');
  });

  it('runs an official account on its own config dir, with no key or args', async () => {
    const work: ModelProvider = {
      id: 'work',
      name: 'Work',
      baseUrl: '',
      models: [],
      account: { agent: 'claude' },
    };
    const resolve = resolver({
      getProviders: async () => [work],
      getApiKey: async () => null,
      getAgentConfig: async () => ({ extraArgs: '--verbose', modelSource: 'work' }),
    });
    expect(await resolve('claude')).toEqual({
      extraArgs: '--verbose',
      modelSource: 'work',
      env: { CLAUDE_CONFIG_DIR: '/accounts/claude-work' },
    });
    await expect(resolve('codex')).rejects.toThrow(/account of another agent/);
  });

  it('refuses to start rather than fall back to the own login', async () => {
    await expect(resolver({ getApiKey: async () => null })('claude')).rejects.toThrow(
      ModelSourceUnavailableError
    );
    await expect(resolver({ getProviders: async () => [] })('claude')).rejects.toThrow(
      /was deleted/
    );
    const chatOnly: ModelProvider = { ...provider, protocol: 'openai-chat' };
    await expect(resolver({ getProviders: async () => [chatOnly] })('codex')).rejects.toThrow(
      /protocol this agent cannot use/
    );
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
    // No model picked: the provider's first one, never the agent's own default.
    expect((await resolve('claude', { modelSource: 'NewAPI' }))?.env?.ANTHROPIC_MODEL).toBe(
      'moonshotai/kimi-k3'
    );
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

    expect(
      await keys.listModels({ providerId: 'p', url: providerModelsUrl(provider), auth: 'bearer' })
    ).toEqual(['a-model', 'b-model']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-1' },
      })
    );

    await keys.listModels({
      providerId: 'p',
      url: 'https://api.anthropic.com/v1/models',
      auth: 'anthropic-api-key',
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-1' },
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
