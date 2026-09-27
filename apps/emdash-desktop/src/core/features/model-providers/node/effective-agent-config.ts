import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import { isProviderCapableAgent, type ModelProvider, type ModelSourceOverride } from '../api';
import { buildSourceLaunch, type AgentProviderFile } from './source-launch';

export type EffectiveAgentConfigDeps = {
  getAgentConfig: (agentId: string) => Promise<ProviderCustomConfig | undefined>;
  getProviders: () => Promise<ModelProvider[]>;
  getApiKey: (providerId: string) => Promise<string | null>;
  ensureProviderFile: (file: AgentProviderFile) => Promise<void>;
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

    const provider = (await deps.getProviders()).find((candidate) => candidate.id === sourceId);
    const apiKey = provider ? await deps.getApiKey(provider.id) : null;
    if (!provider || !apiKey) {
      deps.warn?.('model source unavailable; launching with the agent’s own config', {
        agentId,
        sourceId,
        reason: provider ? 'missing-api-key' : 'unknown-provider',
      });
      return config;
    }

    // No model picked: the provider's first model, not the agent's own default (a Claude
    // or GPT id the provider may not serve).
    const model = (override ? override.sourceModel : config?.sourceModel) || provider.models[0];
    const launch = buildSourceLaunch(agentId, provider, apiKey, model || undefined);
    if (!launch) {
      deps.warn?.('model source has no API this agent can use; launching with its own config', {
        agentId,
        sourceId,
      });
      return config;
    }
    if (launch.file) await deps.ensureProviderFile(launch.file);
    return {
      ...config,
      env: { ...config?.env, ...launch.env },
      extraArgs: [config?.extraArgs?.trim(), ...launch.args].filter(Boolean).join(' '),
    };
  };
}

export type EffectiveAgentConfig = ReturnType<typeof createEffectiveAgentConfig>;
