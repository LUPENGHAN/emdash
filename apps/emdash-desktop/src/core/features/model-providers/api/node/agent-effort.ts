import { getPlugin } from '@core/features/agents/api/node/plugin-registry';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import type { ModelProvider } from '..';
import { userCodexEfforts } from './source-launch';

/** Applies session effort to both native CLI and ACP adapter launch configuration. */
export function withAgentEffort(
  agentId: string,
  config: ProviderCustomConfig | undefined,
  provider?: ModelProvider,
  model?: string
): ProviderCustomConfig | undefined {
  const effort = config?.effort;
  if (!effort) return config;
  const capability = getPlugin(agentId).capabilities.effort;
  if (capability.kind !== 'selectable' || !Object.hasOwn(capability.effortOptions, effort)) {
    throw new Error(`The agent ${agentId} does not support effort ${effort}.`);
  }
  if (provider && model) {
    if (provider.nonReasoningModels?.includes(model)) {
      throw new Error(`The model ${model} has reasoning disabled; remove the effort override.`);
    }
    const supported = agentId === 'codex' ? userCodexEfforts(provider, model) : undefined;
    if (supported && !supported.levels.includes(effort as (typeof supported.levels)[number])) {
      throw new Error(`The model ${model} does not support effort ${effort}.`);
    }
  }
  if (agentId === 'claude') {
    return {
      ...config,
      env: { ...config.env, CLAUDE_CODE_EFFORT_LEVEL: effort },
      extraArgs: [config.extraArgs?.trim(), '--effort', effort].filter(Boolean).join(' '),
    };
  }
  if (agentId === 'codex') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.env?.CODEX_CONFIG ?? '{}');
    } catch {
      throw new Error('CODEX_CONFIG must be valid JSON before applying model effort.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('CODEX_CONFIG must be an object before applying model effort.');
    }
    return {
      ...config,
      env: {
        ...config.env,
        CODEX_CONFIG: JSON.stringify({ ...parsed, model_reasoning_effort: effort }),
      },
      extraArgs: [config.extraArgs?.trim(), `-c model_reasoning_effort=${effort}`]
        .filter(Boolean)
        .join(' '),
    };
  }
  throw new Error(`The agent ${agentId} has no launch integration for default effort.`);
}
