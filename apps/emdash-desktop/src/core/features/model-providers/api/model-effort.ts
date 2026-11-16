import type { ModelProvider } from './index';

type EffortCapability = {
  kind: string;
  effortOptions?: Record<string, { label: string; level: number }>;
};

/** Intersects agent effort support with the configured model's restrictions. */
export function modelEffortOptions(
  capability: EffortCapability | undefined,
  agentId: string,
  provider?: ModelProvider,
  model?: string
): Record<string, { label: string; level: number }> {
  model ??= provider?.models[0];
  if (capability?.kind !== 'selectable') return {};
  if (model && provider?.nonReasoningModels?.includes(model)) return {};
  const restriction =
    agentId === 'codex' && provider
      ? (model && provider.codexReasoningByModel?.[model]) || provider.codexReasoning
      : undefined;
  return Object.fromEntries(
    Object.entries(capability.effortOptions ?? {}).filter(
      ([id]) => !restriction || restriction.levels.some((level) => level === id)
    )
  );
}

export function assertModelEffort(
  effort: string | null | undefined,
  capability: EffortCapability | undefined,
  agentId: string,
  provider?: ModelProvider,
  model?: string
): void {
  if (effort && !Object.hasOwn(modelEffortOptions(capability, agentId, provider, model), effort)) {
    throw new Error(
      `The selected agent/model does not support effort ${effort}. Choose a supported effort or follow the model default.`
    );
  }
}
