import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import { isProviderCapableAgent, type ModelProvider } from '../api';
import { buildSourceLaunch, type AgentProviderFile } from './source-launch';

export type EffectiveAgentConfigDeps = {
  getAgentConfig: (agentId: string) => Promise<ProviderCustomConfig | undefined>;
  getProviders: () => Promise<ModelProvider[]>;
  getApiKey: (providerId: string) => Promise<string | null>;
  ensureProviderFile: (file: AgentProviderFile) => Promise<void>;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

/** A per-conversation choice; `null` source means the agent's own login/config. */
export type ModelSourceOverride = { modelSource: string | null; sourceModel?: string };

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

    const model = override ? override.sourceModel : config?.sourceModel;
    const launch = buildSourceLaunch(agentId, provider, apiKey, model || undefined);
    if (launch.file) await deps.ensureProviderFile(launch.file);
    return {
      ...config,
      env: { ...config?.env, ...launch.env },
      extraArgs: [config?.extraArgs?.trim(), ...launch.args].filter(Boolean).join(' '),
    };
  };
}

export type EffectiveAgentConfig = ReturnType<typeof createEffectiveAgentConfig>;
