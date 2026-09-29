import {
  CLAUDE_MODEL_ALIASES,
  providerConfigId,
  providerEndpoints,
  type ModelProvider,
  type ProviderCapableAgent,
} from '../api';
import {
  codexAppServerWrapperPath,
  codexModelCatalogPath,
  type CodexModelCatalog,
} from './codex-model-catalog';

/**
 * Carries the provider API key into the agent process. Config written to disk (Pi/OMP
 * model files, inline OpenCode/Codex config) references this variable, never the key;
 * only the Codex chat adapter's in-memory sign-in (an env var) carries the key itself.
 */
export const PROVIDER_KEY_ENV = 'EMDASH_MODEL_PROVIDER_KEY';

/**
 * The provider Emdash's Pi / Oh My Pi extension registers in the launched process
 * (EMDASH_AGENT_PROVIDER), and the model it selects when no `--model` is passed
 * (EMDASH_AGENT_MODEL). Names shared with packages/plugins/src/agents/helpers/provider-extension.ts.
 */
export const AGENT_PROVIDER_ENV = 'EMDASH_AGENT_PROVIDER';
export const AGENT_MODEL_ENV = 'EMDASH_AGENT_MODEL';

/** Agents that take a provider through Emdash's extension (Pi, Oh My Pi). */
export type ExtensionProviderAgent = 'pi' | 'oh-my-pi';

export type SourceLaunch = {
  env: Record<string, string>;
  /** Extra CLI arguments; each must be whitespace-free (extraArgs is split on spaces). */
  args: string[];
  /** The agent needs Emdash's extension current (and old model-file entries gone). */
  extensionAgent?: ExtensionProviderAgent;
  /** Model metadata Codex reads (model_catalog_json), written before the launch. */
  codexCatalog?: CodexModelCatalog;
};

/**
 * How an agent runs on a model provider. Everything is injected per launch, so agents
 * started outside Emdash keep their own login and config (Pi and Oh My Pi get the
 * provider from Emdash's extension, which reads it from the launch env).
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
      return {
        env: {
          ANTHROPIC_BASE_URL: anthropic.url,
          ...(anthropic.auth === 'api-key'
            ? { ANTHROPIC_API_KEY: apiKey }
            : { ANTHROPIC_AUTH_TOKEN: apiKey }),
          ...claudeModelEnv(provider, model),
        },
        args: [],
      };
    }
    case 'codex': {
      if (!openai || openai.api === 'chat') return null;
      // Codex sizes its context (and when to compact) from its own model metadata, which a
      // provider's model ids usually miss; the provider's figure, when set, wins.
      const contextWindow = model ? provider.contextWindows?.[model] : undefined;
      // Codex caps the context at its metadata's maximum (272k for models it does not
      // know), so a set context comes with a catalog describing the provider's models.
      const catalogFile = contextWindow ? codexModelCatalogPath(key) : undefined;
      const catalog: CodexModelCatalog | undefined =
        catalogFile && !/\s/.test(catalogFile)
          ? {
              providerKey: key,
              models: Object.entries(provider.contextWindows ?? {})
                .filter(([id]) => provider.models.includes(id))
                .map(([id, tokens]) => ({ id, contextWindow: tokens })),
            }
          : undefined;
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
            ...(contextWindow && { model_context_window: contextWindow }),
            ...(catalog && { model_catalog_json: catalogFile }),
          }),
          MODEL_PROVIDER: key,
          // Without a ChatGPT login the chat UI adapter refuses to start ("sign in")
          // before it ever reads CODEX_CONFIG. This sign-in routes it to the provider
          // instead; it lives in the adapter's memory only, never in Codex's auth.json.
          DEFAULT_AUTH_REQUEST: JSON.stringify({
            methodId: 'gateway',
            _meta: {
              gateway: {
                baseUrl: openai.url,
                providerName: provider.name,
                headers: { Authorization: `Bearer ${apiKey}` },
              },
            },
          }),
          // The adapter logs that request (key included) when this names a folder.
          APP_SERVER_LOGS: '',
          // The chat UI's Codex reads the catalog only at startup (see the wrapper).
          ...(catalog &&
            process.platform !== 'win32' && {
              CODEX_PATH: codexAppServerWrapperPath(),
              EMDASH_CODEX_MODEL_CATALOG: catalogFile!,
            }),
        },
        args: [
          ...codexOverride('model_provider', key),
          ...Object.entries(providerConfig).flatMap(([field, value]) =>
            codexOverride(`model_providers.${key}.${field}`, value)
          ),
          ...(model ? codexOverride('model', model) : []),
          ...(contextWindow ? codexOverride('model_context_window', contextWindow) : []),
          ...(catalog ? codexOverride('model_catalog_json', catalogFile!) : []),
        ],
        ...(catalog && { codexCatalog: catalog }),
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
                models: Object.fromEntries(
                  provider.models.map((id) => {
                    const contextWindow = provider.contextWindows?.[id];
                    return [
                      id,
                      { name: id, ...(contextWindow && { limit: { context: contextWindow } }) },
                    ];
                  })
                ),
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
      const config = {
        key,
        name: provider.name,
        baseUrl: openai ? openai.url : anthropic!.url,
        api: openai
          ? openai.api === 'responses'
            ? 'openai-responses'
            : 'openai-completions'
          : 'anthropic-messages',
        // Pi interpolates $NAME; Oh My Pi resolves a bare env var name.
        apiKey: agent === 'pi' ? `$${PROVIDER_KEY_ENV}` : PROVIDER_KEY_ENV,
        models: provider.models.map((id) => {
          const contextWindow = provider.contextWindows?.[id];
          return { id, ...(contextWindow && { contextWindow }) };
        }),
      };
      return {
        env: {
          [PROVIDER_KEY_ENV]: apiKey,
          [AGENT_PROVIDER_ENV]: JSON.stringify(config),
          ...(model && { [AGENT_MODEL_ENV]: `${key}/${model}` }),
        },
        args: model ? ['--model', `${key}/${model}`] : ['--provider', key],
        extensionAgent: agent,
      };
    }
  }
}

/** Claude Code's context for an ID it strips `[1m]` from before calling the provider. */
const CLAUDE_1M = 1_000_000;

/**
 * Which provider model Claude Code runs for the session, for each alias, and for
 * subagents. Aliases left unset follow a non-Claude main model, so nothing asks the
 * provider for a Claude model it lacks. A model with a 1M window gets Claude Code's
 * `[1m]` marker (per variable, as Claude Code reads it); another set window on the main
 * model sizes the unrecognized models (Claude Code applies it only to those).
 */
function claudeModelEnv(provider: ModelProvider, chosen?: string): Record<string, string> {
  const roles = provider.claude ?? {};
  const main = chosen ?? roles.model;
  const windowOf = (id: string) => provider.contextWindows?.[id];
  const sized = (id: string) =>
    (windowOf(id) ?? 0) >= CLAUDE_1M && !/\[1m\]$/i.test(id) ? `${id}[1m]` : id;
  const fallback = main && !main.startsWith('claude') ? main : undefined;
  const env: Record<string, string> = {};
  if (main) env.ANTHROPIC_MODEL = sized(main);
  for (const alias of CLAUDE_MODEL_ALIASES) {
    const id = roles[alias] ?? fallback;
    if (!id) continue;
    const variable = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
    env[variable] = sized(id);
    const name = roles.names?.[alias]?.trim();
    if (name) env[`${variable}_NAME`] = name;
  }
  // Older Claude Code reads the background model from here.
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  }
  if (roles.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = sized(roles.subagent);
  const mainWindow = main ? windowOf(main) : undefined;
  if (main && mainWindow && mainWindow < CLAUDE_1M && !main.startsWith('claude-')) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(mainWindow);
  }
  return env;
}

function codexOverride(path: string, value: string | number): string[] {
  return ['-c', `${path}=${JSON.stringify(value)}`];
}
