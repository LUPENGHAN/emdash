import {
  anthropicBaseUrl,
  openAiBaseUrl,
  providerConfigId,
  type ModelProvider,
  type ProviderCapableAgent,
} from '../api';

/**
 * Carries the provider API key into the agent process. Config written to disk (Pi/OMP
 * model files, inline OpenCode/Codex config) references this variable, never the key.
 */
export const PROVIDER_KEY_ENV = 'EMDASH_MODEL_PROVIDER_KEY';

/** A provider entry an agent only reads from its own config file (Pi, Oh My Pi). */
export type AgentProviderFile = {
  agent: 'pi' | 'oh-my-pi';
  providerKey: string;
  entry: {
    baseUrl: string;
    api: 'openai-completions';
    apiKey: string;
    models: { id: string }[];
  };
};

export type SourceLaunch = {
  env: Record<string, string>;
  /** Extra CLI arguments; each must be whitespace-free (extraArgs is split on spaces). */
  args: string[];
  file?: AgentProviderFile;
};

/**
 * How an agent runs on a model provider. Everything is injected per launch, so agents
 * started outside Emdash keep their own login and config; only Pi and Oh My Pi, which
 * read providers solely from their model files, get an entry added there (key by env).
 */
export function buildSourceLaunch(
  agent: ProviderCapableAgent,
  provider: ModelProvider,
  apiKey: string,
  model?: string
): SourceLaunch {
  const key = providerConfigId(provider);
  const openAi = openAiBaseUrl(provider.baseUrl);
  switch (agent) {
    case 'claude':
      return {
        env: {
          ANTHROPIC_BASE_URL: anthropicBaseUrl(provider.baseUrl),
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ...(model && { ANTHROPIC_MODEL: model }),
        },
        args: [],
      };
    case 'codex': {
      const providerConfig = {
        name: key,
        base_url: openAi,
        env_key: PROVIDER_KEY_ENV,
        wire_api: 'responses',
      };
      return {
        env: {
          [PROVIDER_KEY_ENV]: apiKey,
          // Read by the chat UI adapter (codex-acp); the terminal CLI takes the -c flags.
          CODEX_CONFIG: JSON.stringify({
            model_provider: key,
            model_providers: { [key]: providerConfig },
            ...(model && { model }),
          }),
          MODEL_PROVIDER: key,
        },
        args: [
          ...codexOverride('model_provider', key),
          ...Object.entries(providerConfig).flatMap(([field, value]) =>
            codexOverride(`model_providers.${key}.${field}`, value)
          ),
          ...(model ? codexOverride('model', model) : []),
        ],
      };
    }
    case 'opencode':
      return {
        env: {
          [PROVIDER_KEY_ENV]: apiKey,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              [key]: {
                npm: '@ai-sdk/openai-compatible',
                name: provider.name,
                options: { baseURL: openAi, apiKey: `{env:${PROVIDER_KEY_ENV}}` },
                models: Object.fromEntries(provider.models.map((id) => [id, { name: id }])),
              },
            },
            ...(model && { model: `${key}/${model}` }),
          }),
        },
        args: [],
      };
    case 'pi':
    case 'oh-my-pi':
      return {
        env: { [PROVIDER_KEY_ENV]: apiKey },
        args: model ? ['--model', `${key}/${model}`] : ['--provider', key],
        file: {
          agent,
          providerKey: key,
          entry: {
            baseUrl: openAi,
            api: 'openai-completions',
            apiKey: `$${PROVIDER_KEY_ENV}`,
            models: provider.models.map((id) => ({ id })),
          },
        },
      };
  }
}

function codexOverride(path: string, value: string): string[] {
  return ['-c', `${path}=${JSON.stringify(value)}`];
}
