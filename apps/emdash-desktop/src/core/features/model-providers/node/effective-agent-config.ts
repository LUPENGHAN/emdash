import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import {
  isOfficialAccount,
  isProviderCapableAgent,
  MODEL_SOURCE_UNAVAILABLE_HINT,
  type ModelProvider,
  type ProviderProtocol,
  providerProtocolForAgent,
  type ModelSourceOverride,
  type OfficialAccount,
} from '../api';
import type { CodexModelCatalog, CodexModelInfo } from '../api/node/codex-launch';
import { buildSourceLaunch, type ExtensionProviderAgent } from '../api/node/source-launch';
import { ACCOUNT_HOME_ENV } from './official-accounts';

export type EffectiveAgentConfigDeps = {
  nativeSourceAvailable?: (
    agentId: string,
    config: ProviderCustomConfig | undefined
  ) => Promise<boolean>;
  getAgentConfig: (agentId: string) => Promise<ProviderCustomConfig | undefined>;
  getProviders: () => Promise<ModelProvider[]>;
  prepareGateway?: (
    sourceId: string,
    model: string | undefined,
    conversationId?: string,
    agentId?: string
  ) => Promise<{ provider: ModelProvider; apiKey: string; compatibility?: boolean }>;
  getApiKey: (providerId: string, protocol?: ProviderProtocol) => Promise<string | null>;
  prepareAgentProvider: (agent: ExtensionProviderAgent) => Promise<void>;
  ensureCodexAppServerWrapper?: () => Promise<void>;
  ensureCodexModelCatalog?: (catalog: CodexModelCatalog) => Promise<void>;
  /** Codex's cached model metadata, for the effort a model it knows starts with. */
  readKnownCodexModels?: () => Promise<CodexModelInfo[]>;
  /** Readies an official account's config dir and returns it. */
  prepareAccountHome: (account: OfficialAccount) => Promise<string>;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

/**
 * The agent config a launch should use: the user's own env/args plus, when the agent is
 * set to run on a model provider, what that provider needs. Both the terminal and chat
 * launch paths read agent config through this, so a source applies to either UI.
 */
export function createEffectiveAgentConfig(deps: EffectiveAgentConfigDeps) {
  return async (
    agentId: string,
    override?: ModelSourceOverride
  ): Promise<ProviderCustomConfig | undefined> => {
    const config = await deps.getAgentConfig(agentId);
    const sourceId =
      override?.modelSource !== undefined ? override.modelSource : config?.modelSource;
    if (
      override?.modelSource === null &&
      ['claude', 'codex'].includes(agentId) &&
      deps.nativeSourceAvailable &&
      !(await deps.nativeSourceAvailable(agentId, config))
    ) {
      throw new ModelSourceUnavailableError(
        'The agent’s own configuration points to a custom API. Select a separate official account or remove that override before choosing official login.'
      );
    }
    if (sourceId === 'gateway:models' && !isProviderCapableAgent(agentId))
      throw new ModelSourceUnavailableError('This agent has no gateway launch integration.');
    if (!sourceId || !isProviderCapableAgent(agentId)) return withCodexContext(agentId, config);

    // A chosen provider that cannot be used stops the launch: falling back to the
    // agent's own login would silently spend the user's subscription instead.
    const gateway = sourceId.startsWith('gateway:');
    if (gateway && !deps.prepareGateway)
      throw new ModelSourceUnavailableError('This agent cannot use the local gateway.');
    const target = gateway
      ? await deps.prepareGateway!(
          sourceId,
          override?.modelSource !== undefined ? override.sourceModel : config?.sourceModel,
          override?.conversationId,
          ...(sourceId === 'gateway:models' ? [agentId] : [])
        )
      : undefined;
    const provider =
      target?.provider ??
      (await deps.getProviders()).find((candidate) => candidate.id === sourceId);
    if (!provider) {
      throw new ModelSourceUnavailableError(
        'The provider this agent is set to run on was deleted.'
      );
    }
    if (isOfficialAccount(provider)) {
      // Another sign-in of the agent's own vendor: only its config (and login) dir moves.
      if (provider.account.agent !== agentId) {
        throw new ModelSourceUnavailableError(`“${provider.name}” is an account of another agent.`);
      }
      const home = await deps.prepareAccountHome(provider);
      return withCodexContext(agentId, {
        ...config,
        env: { ...config?.env, [ACCOUNT_HOME_ENV[provider.account.agent]]: home },
      });
    }
    const keyProtocol = providerProtocolForAgent(provider, agentId);
    const apiKey =
      target?.apiKey ??
      (await deps.getApiKey(provider.id, keyProtocol)) ??
      (await deps.getApiKey(provider.id));
    if (!apiKey) {
      throw new ModelSourceUnavailableError(
        `The provider “${provider.name}” has no API key saved.`
      );
    }

    // No model picked: the provider's first model, not the agent's own default (a Claude
    // or GPT id the provider may not serve).
    const model = target
      ? provider.models[0]
      : (override?.modelSource !== undefined ? override.sourceModel : config?.sourceModel) ||
        provider.models[0];
    const known = agentId === 'codex' ? await deps.readKnownCodexModels?.() : undefined;
    const launch = buildSourceLaunch(
      agentId,
      provider,
      apiKey,
      model || undefined,
      known,
      target?.compatibility
    );
    if (!launch) {
      throw new ModelSourceUnavailableError(
        `The provider “${provider.name}” speaks a protocol this agent cannot use.`
      );
    }
    if (launch.extensionAgent) await deps.prepareAgentProvider(launch.extensionAgent);
    if (launch.codexWrapper) await deps.ensureCodexAppServerWrapper?.();
    if (launch.codexCatalog) {
      await deps.ensureCodexModelCatalog?.(launch.codexCatalog);
    } else if (agentId === 'codex' && provider.models.length > 0) {
      // The catalog path cannot ride the space-split extraArgs (or breaks the
      // Windows wrapper's TOML literal), so Codex falls back to its own models.
      deps.warn?.('Codex model catalog path has whitespace; Codex will list its own models', {
        providerId: provider.id,
      });
    }
    return {
      ...config,
      env: { ...config?.env, ...launch.env },
      extraArgs: [config?.extraArgs?.trim(), ...launch.args].filter(Boolean).join(' '),
    };
  };
}

/** OpenAI's metadata caps official Codex models here; Codex clamps anything larger. */
export const CODEX_OFFICIAL_MAX_CONTEXT = 872_000;
/** Codex compacts at 90% of its window by default; kept in step with a set window. */
const CODEX_AUTO_COMPACT_RATIO = 0.9;

/**
 * Codex on its own login sizes its context from OpenAI's model metadata (272k by default).
 * A set window goes to the chat adapter through `CODEX_CONFIG` and to the terminal CLI as
 * `-c` flags, with the auto-compact limit moved along so compaction does not fire at 245k.
 */
export function withCodexContext(
  agentId: string,
  config: ProviderCustomConfig | undefined
): ProviderCustomConfig | undefined {
  const window = config?.contextWindow;
  if (agentId !== 'codex' || !window) return config;
  const tokens = Math.min(window, CODEX_OFFICIAL_MAX_CONTEXT);
  const compactAt = Math.round(tokens * CODEX_AUTO_COMPACT_RATIO);
  let userConfig: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(config.env?.CODEX_CONFIG ?? '{}');
    if (parsed && typeof parsed === 'object') userConfig = parsed as Record<string, unknown>;
  } catch {
    // An unreadable user value is replaced rather than passed on broken.
  }
  return {
    ...config,
    env: {
      ...config.env,
      CODEX_CONFIG: JSON.stringify({
        ...userConfig,
        model_context_window: tokens,
        model_auto_compact_token_limit: compactAt,
      }),
    },
    extraArgs: [
      config.extraArgs?.trim(),
      `-c model_context_window=${tokens}`,
      `-c model_auto_compact_token_limit=${compactAt}`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Why an agent set to run on a provider cannot start; it never falls back to its own login. */
export class ModelSourceUnavailableError extends Error {
  constructor(reason: string) {
    super(`${reason} ${MODEL_SOURCE_UNAVAILABLE_HINT}`);
    this.name = 'ModelSourceUnavailableError';
  }
}

export type EffectiveAgentConfig = ReturnType<typeof createEffectiveAgentConfig>;
