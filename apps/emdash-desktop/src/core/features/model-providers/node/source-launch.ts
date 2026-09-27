import {
  providerConfigId,
  providerEndpoints,
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
    api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
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
 * Claude Code needs Anthropic Messages and Codex OpenAI Responses; the others speak any
 * of the protocols. Null when the provider's protocol does not suit the agent.
 */
export function buildSourceLaunch(
  agent: ProviderCapableAgent,
  provider: ModelProvider,
  apiKey: string,
  model?: string
): SourceLaunch | null {
  const key = providerConfigId(provider);
  const { anthropic, openai } = providerEndpoints(provider);
  switch (agent) {
    case 'claude': {
      if (!anthropic) return null;
      // Other vendors' models: point Claude Code's Opus/Sonnet/Haiku aliases (sub-agents,
      // titles, /model) at them too, so nothing asks the provider for a Claude model it lacks.
      const aliases = model && !model.startsWith('claude') ? model : undefined;
      return {
        env: {
          ANTHROPIC_BASE_URL: anthropic.url,
          ...(anthropic.auth === 'api-key'
            ? { ANTHROPIC_API_KEY: apiKey }
            : { ANTHROPIC_AUTH_TOKEN: apiKey }),
          ...(model && { ANTHROPIC_MODEL: model }),
          ...(aliases && {
            ANTHROPIC_DEFAULT_OPUS_MODEL: aliases,
            ANTHROPIC_DEFAULT_SONNET_MODEL: aliases,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: aliases,
            ANTHROPIC_SMALL_FAST_MODEL: aliases,
          }),
        },
        args: [],
      };
    }
    case 'codex': {
      if (!openai || openai.api === 'chat') return null;
      const providerConfig = {
        name: key,
        base_url: openai.url,
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
    case 'opencode': {
      if (!openai && !anthropic) return null;
      const options = openai
        ? {
            npm: openai.api === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
            baseURL: openai.url,
          }
        : { npm: '@ai-sdk/anthropic', baseURL: `${anthropic!.url}/v1` };
      return {
        env: {
          [PROVIDER_KEY_ENV]: apiKey,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              [key]: {
                npm: options.npm,
                name: provider.name,
                options: { baseURL: options.baseURL, apiKey: `{env:${PROVIDER_KEY_ENV}}` },
                models: Object.fromEntries(provider.models.map((id) => [id, { name: id }])),
              },
            },
            ...(model && { model: `${key}/${model}` }),
          }),
        },
        args: [],
      };
    }
    case 'pi':
    case 'oh-my-pi': {
      if (!openai && !anthropic) return null;
      return {
        env: { [PROVIDER_KEY_ENV]: apiKey },
        args: model ? ['--model', `${key}/${model}`] : ['--provider', key],
        file: {
          agent,
          providerKey: key,
          entry: {
            baseUrl: openai ? openai.url : anthropic!.url,
            api: openai
              ? openai.api === 'responses'
                ? 'openai-responses'
                : 'openai-completions'
              : 'anthropic-messages',
            apiKey: `$${PROVIDER_KEY_ENV}`,
            models: provider.models.map((id) => ({ id })),
          },
        },
      };
    }
  }
}

function codexOverride(path: string, value: string): string[] {
  return ['-c', `${path}=${JSON.stringify(value)}`];
}
