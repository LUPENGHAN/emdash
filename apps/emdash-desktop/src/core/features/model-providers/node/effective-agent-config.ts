import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import {
  isOfficialAccount,
  isProviderCapableAgent,
  MODEL_SOURCE_UNAVAILABLE_HINT,
  type ModelProvider,
  type ModelSourceOverride,
  type OfficialAccount,
} from '../api';
import type { CodexModelCatalog } from './codex-model-catalog';
import { ACCOUNT_HOME_ENV } from './official-accounts';
import { buildSourceLaunch, type ExtensionProviderAgent } from './source-launch';

export type EffectiveAgentConfigDeps = {
  getAgentConfig: (agentId: string) => Promise<ProviderCustomConfig | undefined>;
  getProviders: () => Promise<ModelProvider[]>;
  getApiKey: (providerId: string) => Promise<string | null>;
  prepareAgentProvider: (agent: ExtensionProviderAgent) => Promise<void>;
  ensureCodexModelCatalog?: (catalog: CodexModelCatalog) => Promise<void>;
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
    const sourceId = override ? override.modelSource : config?.modelSource;
    if (!sourceId || !isProviderCapableAgent(agentId)) return config;

    // A chosen provider that cannot be used stops the launch: falling back to the
    // agent's own login would silently spend the user's subscription instead.
    const provider = (await deps.getProviders()).find((candidate) => candidate.id === sourceId);
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
      return {
        ...config,
        env: { ...config?.env, [ACCOUNT_HOME_ENV[provider.account.agent]]: home },
      };
    }
    const apiKey = await deps.getApiKey(provider.id);
    if (!apiKey) {
      throw new ModelSourceUnavailableError(
        `The provider “${provider.name}” has no API key saved.`
      );
    }

    // No model picked: the provider's first model, not the agent's own default (a Claude
    // or GPT id the provider may not serve).
    const model = (override ? override.sourceModel : config?.sourceModel) || provider.models[0];
    const launch = buildSourceLaunch(agentId, provider, apiKey, model || undefined);
    if (!launch) {
      throw new ModelSourceUnavailableError(
        `The provider “${provider.name}” speaks a protocol this agent cannot use.`
      );
    }
    if (launch.extensionAgent) await deps.prepareAgentProvider(launch.extensionAgent);
    if (launch.codexCatalog) await deps.ensureCodexModelCatalog?.(launch.codexCatalog);
    return {
      ...config,
      env: { ...config?.env, ...launch.env },
      extraArgs: [config?.extraArgs?.trim(), ...launch.args].filter(Boolean).join(' '),
    };
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
