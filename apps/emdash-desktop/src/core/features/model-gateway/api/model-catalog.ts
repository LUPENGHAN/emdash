import { z } from 'zod';
import {
  PROVIDER_PROTOCOLS,
  modelProviderSchema,
  type ModelProvider,
  type ProviderProtocol,
} from '@core/features/model-providers/api';

export const catalogSourceId = 'gateway:models';
export const codexNativeRouteRequired =
  'Codex gateway models require a native OpenAI Responses route.';
const protocol = z.enum(PROVIDER_PROTOCOLS);
const protocolModels = z.partialRecord(protocol, z.object({ upstreamModel: z.string().min(1) }));
export const gatewayModelSchema = z
  .object({
    id: z.string().min(1),
    alias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, 'Use a stable model identifier'),
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    revision: z.number().int().positive().default(1),
    providerId: z.string().min(1),
    protocolModels: protocolModels.refine((v) => Object.keys(v).length > 0, 'Select a protocol'),
    protocolPolicy: z
      .discriminatedUnion('mode', [
        z.object({
          mode: z.literal('auto'),
          conversionTargets: z.partialRecord(protocol, protocol).optional(),
        }),
        z.object({ mode: z.literal('fixed'), protocol }),
      ])
      .default({ mode: 'auto' }),
    contextWindow: z.number().int().positive().optional(),
    nonReasoning: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    codexReasoning: modelProviderSchema.shape.codexReasoning,
  })
  .superRefine((model, ctx) => {
    if (
      model.protocolPolicy.mode === 'fixed' &&
      !model.protocolModels[model.protocolPolicy.protocol]
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['protocolPolicy'],
        message: 'The fixed protocol must be enabled for this model',
      });
    }
  });
export type GatewayModel = z.infer<typeof gatewayModelSchema>;
export const gatewayModelsSettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    models: z.array(gatewayModelSchema).default([]),
  })
  .superRefine(({ models }, ctx) => {
    for (const key of ['id', 'alias'] as const) {
      const seen = new Set<string>();
      models.forEach((model, index) => {
        if (seen.has(model[key]))
          ctx.addIssue({
            code: 'custom',
            path: ['models', index, key],
            message: `Duplicate model ${key}`,
          });
        seen.add(model[key]);
      });
    }
  });
export type GatewayModelsSettings = z.infer<typeof gatewayModelsSettingsSchema>;

/** Matches the request/stream/JSON converters in the pinned SDK builtin registry. */
export const conversionTargets: Record<ProviderProtocol, readonly ProviderProtocol[]> = {
  anthropic: ['openai-chat'],
  'openai-responses': ['anthropic', 'openai-chat'],
  'openai-chat': ['anthropic'],
};

export function upstreamProtocol(
  model: GatewayModel,
  inbound: ProviderProtocol
): ProviderProtocol | null {
  const supports = (target: ProviderProtocol) => Boolean(model.protocolModels[target]);
  if (model.protocolPolicy.mode === 'fixed') {
    const target = model.protocolPolicy.protocol;
    return supports(target) && (target === inbound || conversionTargets[inbound].includes(target))
      ? target
      : null;
  }
  if (supports(inbound)) return inbound;
  const explicit = model.protocolPolicy.conversionTargets?.[inbound];
  const targets = explicit ? [explicit] : conversionTargets[inbound];
  return (
    targets.find((target) => supports(target) && conversionTargets[inbound].includes(target)) ??
    null
  );
}

export function inboundProtocolForAgent(agent: string): ProviderProtocol {
  return agent === 'claude' ? 'anthropic' : 'openai-responses';
}

export function agentUpstreamProtocol(model: GatewayModel, agent: string): ProviderProtocol | null {
  const inbound = inboundProtocolForAgent(agent);
  const target = upstreamProtocol(model, inbound);
  // Codex sends Responses-specific state and tool definitions in its normal requests.
  return agent === 'codex' && target !== inbound ? null : target;
}

export function configuredProtocols(provider: ModelProvider): ProviderProtocol[] {
  return provider.endpoints
    ? PROVIDER_PROTOCOLS.filter((p) => provider.endpoints?.[p] !== undefined)
    : provider.protocol
      ? [provider.protocol]
      : [...PROVIDER_PROTOCOLS];
}

export function modelAvailableForAgent(
  model: GatewayModel,
  provider: ModelProvider | undefined,
  agent: string
): boolean {
  return Boolean(
    model.enabled &&
    provider &&
    !provider.account &&
    Object.keys(model.protocolModels).every((protocol) =>
      configuredProtocols(provider).includes(protocol as ProviderProtocol)
    ) &&
    agentUpstreamProtocol(model, agent)
  );
}

export function catalogProvider(models: GatewayModel[], agent?: string): ModelProvider {
  const available = models.filter((m) => m.enabled && (!agent || agentUpstreamProtocol(m, agent)));
  return {
    id: catalogSourceId,
    name: 'Gateway',
    baseUrl: '',
    models: available.map((m) => m.alias),
    modelNames: Object.fromEntries(available.map((m) => [m.alias, m.name])),
    contextWindows: Object.fromEntries(
      available.flatMap((m) => (m.contextWindow ? [[m.alias, m.contextWindow]] : []))
    ),
    nonReasoningModels: available.filter((m) => m.nonReasoning).map((m) => m.alias),
    webSearchModels: available.filter((m) => m.webSearch).map((m) => m.alias),
    codexReasoningByModel: Object.fromEntries(
      available.flatMap((m) => (m.codexReasoning ? [[m.alias, m.codexReasoning]] : []))
    ),
  };
}
