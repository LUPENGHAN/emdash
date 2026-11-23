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
const alias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, 'Use a stable model identifier');
const protocolModels = z.partialRecord(protocol, z.object({ upstreamModel: z.string().min(1) }));
const protocolPolicy = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('auto'),
      conversionTargets: z.partialRecord(protocol, protocol).optional(),
    }),
    z.object({ mode: z.literal('fixed'), protocol }),
  ])
  .default({ mode: 'auto' });

/** Immutable route binding stored in a conversation snapshot. */
export const gatewayModelSchema = z
  .object({
    id: z.string().min(1),
    alias,
    name: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    revision: z.number().int().positive().default(1),
    providerId: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    protocolModels: protocolModels.refine((v) => Object.keys(v).length > 0, 'Select a protocol'),
    protocolPolicy,
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

export const gatewayModelSourceSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    enabled: z.boolean().default(true),
    protocolModels: protocolModels.refine((v) => Object.keys(v).length > 0, 'Select a protocol'),
    protocolPolicy,
  })
  .superRefine((source, ctx) => {
    if (
      source.protocolPolicy.mode === 'fixed' &&
      !source.protocolModels[source.protocolPolicy.protocol]
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['protocolPolicy'],
        message: 'The fixed protocol must be enabled for this source',
      });
    }
  });
export type GatewayModelSource = z.infer<typeof gatewayModelSourceSchema>;

export const publishedGatewayModelSchema = z
  .object({
    id: z.string().min(1),
    primaryAlias: alias,
    legacyAliases: z.array(alias).default([]),
    displayName: z.string().trim().min(1),
    state: z.enum(['active', 'hidden', 'disabled', 'archived']).default('active'),
    revision: z.number().int().positive().default(1),
    sources: z.array(gatewayModelSourceSchema).min(1),
    activeSourceByProtocol: z.partialRecord(protocol, z.string().min(1)),
    contextWindow: z.number().int().positive().optional(),
    nonReasoning: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    codexReasoning: modelProviderSchema.shape.codexReasoning,
  })
  .superRefine((model, ctx) => {
    const sourceIds = new Set<string>();
    model.sources.forEach((source, index) => {
      if (sourceIds.has(source.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', index, 'id'],
          message: 'Duplicate source id',
        });
      }
      sourceIds.add(source.id);
    });
    for (const [selectedProtocol, sourceId] of Object.entries(model.activeSourceByProtocol)) {
      if (!sourceIds.has(sourceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['activeSourceByProtocol', selectedProtocol],
          message: 'The selected source is missing',
        });
      }
    }
    if (
      new Set([model.primaryAlias, ...model.legacyAliases]).size !==
      1 + model.legacyAliases.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['legacyAliases'],
        message: 'Model aliases must be unique',
      });
    }
  });
export type PublishedGatewayModel = z.infer<typeof publishedGatewayModelSchema>;

const gatewayModelsV1Schema = z
  .object({
    version: z.literal(1).default(1),
    models: z.array(gatewayModelSchema).default([]),
  })
  .superRefine(({ models }, ctx) => {
    for (const key of ['id', 'alias'] as const) {
      const seen = new Set<string>();
      models.forEach((model, index) => {
        if (seen.has(model[key])) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', index, key],
            message: `Duplicate model ${key}`,
          });
        }
        seen.add(model[key]);
      });
    }
  });

const gatewayModelsV2Schema = z
  .object({
    version: z.literal(2).default(2),
    models: z.array(publishedGatewayModelSchema).default([]),
    ignoredSourceIds: z.array(z.string().min(1)).default([]),
    legacyModels: z.array(gatewayModelSchema).optional(),
    migration: z.object({ fromVersion: z.literal(1) }).optional(),
  })
  .superRefine(({ models }, ctx) => {
    const modelIds = new Set<string>();
    const aliases = new Set<string>();
    models.forEach((model, index) => {
      if (modelIds.has(model.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', index, 'id'],
          message: 'Duplicate model id',
        });
      }
      modelIds.add(model.id);
      for (const candidate of [model.primaryAlias, ...model.legacyAliases]) {
        if (aliases.has(candidate)) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', index, 'primaryAlias'],
            message: 'Duplicate model alias',
          });
        }
        aliases.add(candidate);
      }
    });
  });

export type GatewayModelsSettings = z.infer<typeof gatewayModelsV2Schema>;

export function migrateGatewayModelsV1(
  settings: z.infer<typeof gatewayModelsV1Schema>
): GatewayModelsSettings {
  return {
    version: 2,
    models: settings.models.map((model) => {
      const sourceId = `source:${model.id}`;
      return {
        id: model.id,
        primaryAlias: model.alias,
        legacyAliases: [],
        displayName: model.name,
        state: model.enabled ? 'active' : 'disabled',
        revision: model.revision,
        sources: [
          {
            id: sourceId,
            providerId: model.providerId,
            enabled: true,
            protocolModels: model.protocolModels,
            protocolPolicy: model.protocolPolicy,
          },
        ],
        activeSourceByProtocol: Object.fromEntries(
          PROVIDER_PROTOCOLS.map((candidate) => [candidate, sourceId])
        ),
        contextWindow: model.contextWindow,
        nonReasoning: model.nonReasoning,
        webSearch: model.webSearch,
        codexReasoning: model.codexReasoning,
      };
    }),
    ignoredSourceIds: [],
    legacyModels: structuredClone(settings.models),
    migration: { fromVersion: 1 },
  };
}

/** V1 is read losslessly; the next explicit save persists V2 and retains a read-only backup. */
export const gatewayModelsSettingsSchema = z.union([
  gatewayModelsV2Schema,
  gatewayModelsV1Schema.transform(migrateGatewayModelsV1),
]);

export function publishedModelAliases(model: PublishedGatewayModel): string[] {
  return [model.primaryAlias, ...model.legacyAliases];
}

export function findPublishedModel(
  models: PublishedGatewayModel[],
  modelAlias: string | undefined
): PublishedGatewayModel | undefined {
  return modelAlias
    ? models.find((model) => publishedModelAliases(model).includes(modelAlias))
    : undefined;
}

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
  return agent === 'codex' && target !== inbound ? null : target;
}

export function configuredProtocols(provider: ModelProvider): ProviderProtocol[] {
  return provider.endpoints
    ? PROVIDER_PROTOCOLS.filter((p) => provider.endpoints?.[p] !== undefined)
    : provider.protocol
      ? [provider.protocol]
      : [...PROVIDER_PROTOCOLS];
}

export function gatewayBindingFromSource(
  model: PublishedGatewayModel,
  source: GatewayModelSource,
  modelAlias = model.primaryAlias
): GatewayModel {
  return {
    id: model.id,
    alias: modelAlias,
    name: model.displayName,
    enabled: model.state === 'active' && source.enabled,
    revision: model.revision,
    providerId: source.providerId,
    sourceId: source.id,
    protocolModels: source.protocolModels,
    protocolPolicy: source.protocolPolicy,
    contextWindow: model.contextWindow,
    nonReasoning: model.nonReasoning,
    webSearch: model.webSearch,
    codexReasoning: model.codexReasoning,
  };
}

export function activeSourceForAgent(
  model: PublishedGatewayModel,
  agent: string
): GatewayModelSource | undefined {
  const sourceId = model.activeSourceByProtocol[inboundProtocolForAgent(agent)];
  return sourceId
    ? model.sources.find((source) => source.id === sourceId && source.enabled)
    : undefined;
}

export function modelAvailableForAgent(
  model: PublishedGatewayModel,
  providers: ModelProvider[],
  agent: string
): boolean {
  if (model.state !== 'active') return false;
  const source = activeSourceForAgent(model, agent);
  const provider = source && providers.find((candidate) => candidate.id === source.providerId);
  if (!source || !provider || provider.account) return false;
  const binding = gatewayBindingFromSource(model, source);
  return Boolean(
    Object.keys(source.protocolModels).every((candidate) =>
      configuredProtocols(provider).includes(candidate as ProviderProtocol)
    ) && agentUpstreamProtocol(binding, agent)
  );
}

type CatalogModel = GatewayModel | PublishedGatewayModel;

function isPublishedModel(model: CatalogModel): model is PublishedGatewayModel {
  return 'sources' in model;
}

export function catalogProvider(models: CatalogModel[], agent?: string): ModelProvider {
  const available = models.flatMap((model) => {
    if (!isPublishedModel(model)) {
      return model.enabled && (!agent || agentUpstreamProtocol(model, agent)) ? [model] : [];
    }
    if (model.state !== 'active') return [];
    const source = agent
      ? activeSourceForAgent(model, agent)
      : model.sources.find((candidate) => candidate.enabled);
    if (!source) return [];
    const binding = gatewayBindingFromSource(model, source);
    return !agent || agentUpstreamProtocol(binding, agent) ? [binding] : [];
  });
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
