import { createHash } from 'node:crypto';
import {
  PROVIDER_PROTOCOLS,
  type ModelProvider,
  type ProviderProtocol,
} from '@core/features/model-providers/api';
import {
  activeSourceForAgent,
  agentUpstreamProtocol,
  codexNativeRouteRequired,
  configuredProtocols,
  gatewayBindingFromSource,
  modelAvailableForAgent,
  publishedModelAliases,
  upstreamProtocol,
  type GatewayModel,
  type PublishedGatewayModel,
} from '../api/model-catalog';
import type { ApiProvider } from './config';

export type CatalogSnapshot = {
  scope?: 'task';
  agent: string;
  claudeUpstreamProtocol?: ProviderProtocol;
  /** Frozen route bindings. V2 directory records are flattened before reaching this snapshot. */
  models: GatewayModel[];
  providers: ModelProvider[];
};

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function snapshotCatalog(
  models: PublishedGatewayModel[],
  providers: ModelProvider[],
  agent: string,
  requestedAlias?: string
): CatalogSnapshot {
  const available = models.flatMap((model) => {
    if (!modelAvailableForAgent(model, providers, agent)) return [];
    const source = activeSourceForAgent(model, agent);
    if (!source) return [];
    const primary = gatewayBindingFromSource(model, source);
    return requestedAlias &&
      requestedAlias !== model.primaryAlias &&
      publishedModelAliases(model).includes(requestedAlias)
      ? [primary, gatewayBindingFromSource(model, source, requestedAlias)]
      : [primary];
  });
  return {
    agent,
    models: available,
    providers: providers
      .filter((provider) => available.some((model) => model.providerId === provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        endpoints: provider.endpoints,
        models: [],
      })),
  };
}

/** Claude's protocol-dependent features are set for the lifetime of the agent. */
export function scopeClaudeCatalog(
  snapshot: CatalogSnapshot,
  protocol: ProviderProtocol
): CatalogSnapshot {
  const models = snapshot.models.filter(
    (model) => upstreamProtocol(model, 'anthropic') === protocol
  );
  return { ...withCatalogModels(snapshot, models), claudeUpstreamProtocol: protocol };
}

/** Older Codex snapshots could include conversion-only models. */
export function scopeCodexCatalog(snapshot: CatalogSnapshot): CatalogSnapshot {
  return snapshot.agent === 'codex'
    ? withCatalogModels(
        snapshot,
        snapshot.models.filter((model) => agentUpstreamProtocol(model, 'codex'))
      )
    : snapshot;
}

function withCatalogModels(snapshot: CatalogSnapshot, models: GatewayModel[]): CatalogSnapshot {
  return {
    ...snapshot,
    models,
    providers: snapshot.providers.filter((provider) =>
      models.some((model) => model.providerId === provider.id)
    ),
  };
}

/** Connection identity excludes credentials so a key rotation keeps its target scope. */
export function connectionIdentity(provider: ModelProvider): string {
  return fingerprint({
    id: provider.id,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    endpoints: provider.endpoints,
    account: provider.account,
  });
}

export function catalogBindings(snapshot: CatalogSnapshot): string {
  return fingerprint({
    models: snapshot.models.map(({ name: _name, revision: _revision, ...model }) => model),
    connections: snapshot.providers.map(connectionIdentity).sort(),
    agent: snapshot.agent,
  });
}

export function runtimeProviderId(model: GatewayModel, provider: ModelProvider): string {
  return 'model:' + fingerprint({ model, connection: connectionIdentity(provider) });
}

/** Reuses keys only while the saved connection scope still matches the inventory. */
export function runtimeCatalog(
  snapshot: CatalogSnapshot,
  inventory: ModelProvider[],
  providers: ApiProvider[]
): { providers: ApiProvider[]; models: Record<string, string> } {
  const entries: ApiProvider[] = [];
  const models: Record<string, string> = {};
  for (const model of scopeCodexCatalog(snapshot).models) {
    const saved = snapshot.providers.find((provider) => provider.id === model.providerId);
    const current = inventory.find((provider) => provider.id === model.providerId);
    const runtime = providers.find((provider) => provider.id === model.providerId);
    if (!saved || !current || !runtime || connectionIdentity(saved) !== connectionIdentity(current))
      continue;
    const id = runtimeProviderId(model, saved);
    const mapping = Object.fromEntries(
      Object.entries(model.protocolModels).map(([selectedProtocol, binding]) => [
        selectedProtocol,
        binding.upstreamModel,
      ])
    );
    entries.push({
      ...runtime,
      id,
      name: model.name,
      models: [model.alias],
      modelMap: { [model.alias]: Object.values(mapping)[0] },
      contextWindows: model.contextWindow ? { [model.alias]: model.contextWindow } : {},
      route: {
        ...(snapshot.scope === 'task' && { requestedModel: model.name }),
        providerId: model.providerId,
        revision: model.revision,
        protocolModels: { [model.alias]: mapping },
        policy: model.protocolPolicy,
      },
    });
    models[model.alias] = id;
  }
  return { providers: entries, models };
}

/** Deterministic discovery preview. It never merges providers automatically. */
export function migrationPreview(providers: ModelProvider[]): PublishedGatewayModel[] {
  const counts = new Map<string, number>();
  for (const provider of providers.filter((candidate) => !candidate.account)) {
    for (const model of provider.models) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return providers
    .filter((provider) => !provider.account)
    .flatMap((provider) =>
      provider.models.map((model) => {
        const id = fingerprint([provider.id, model]).slice(0, 12);
        const base =
          model.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'model';
        const primaryAlias = counts.get(model) === 1 && base === model ? base : `${base}-${id}`;
        const sourceId = `source:${id}`;
        return {
          id: `import-${id}`,
          primaryAlias,
          legacyAliases: [],
          displayName: model,
          state: 'active' as const,
          revision: 1,
          sources: [
            {
              id: sourceId,
              providerId: provider.id,
              enabled: true,
              protocolModels: Object.fromEntries(
                configuredProtocols(provider).map((selectedProtocol) => [
                  selectedProtocol,
                  { upstreamModel: provider.modelAliases?.[model] ?? model },
                ])
              ),
              protocolPolicy: { mode: 'auto' as const },
            },
          ],
          activeSourceByProtocol: Object.fromEntries(
            PROVIDER_PROTOCOLS.map((selectedProtocol) => [selectedProtocol, sourceId])
          ),
          contextWindow: provider.contextWindows?.[model],
          nonReasoning: provider.nonReasoningModels?.includes(model),
          webSearch: provider.webSearchModels?.includes(model),
          codexReasoning: provider.codexReasoningByModel?.[model] ?? provider.codexReasoning,
        };
      })
    );
}

/** Builds a private catalog without publishing or changing any global alias. */
export function taskModelCatalog(
  provider: ModelProvider,
  model: string,
  agent: string,
  published: PublishedGatewayModel[]
): CatalogSnapshot {
  if (provider.account) throw new Error('Select an API supplier for a task gateway route.');
  if (!model.trim()) throw new Error('Specify a supplier model for this task.');
  const matches = published.flatMap((entry) =>
    entry.sources
      .filter(
        (source) =>
          source.providerId === provider.id &&
          Object.values(source.protocolModels).some((mapping) => mapping.upstreamModel === model)
      )
      .map((source) => gatewayBindingFromSource(entry, source))
  );
  if (
    matches.length > 1 &&
    matches.some(
      (entry) => fingerprint(entry.protocolModels) !== fingerprint(matches[0].protocolModels)
    )
  ) {
    throw new Error('The model has multiple protocol mappings. Select a public model alias.');
  }
  const protocols = configuredProtocols(provider);
  if (!matches.length && !provider.models.includes(model) && protocols.length !== 1) {
    throw new Error(
      'Configure protocol mappings for this supplier model or select a single-protocol supplier.'
    );
  }
  const binding: GatewayModel = {
    ...(matches[0] ?? {
      protocolModels: Object.fromEntries(
        protocols.map((selectedProtocol) => [
          selectedProtocol,
          { upstreamModel: provider.modelAliases?.[model] ?? model },
        ])
      ),
      protocolPolicy: { mode: 'auto' as const },
    }),
    id: `task:${fingerprint([provider.id, model])}`,
    alias: 'task-model',
    name: model,
    enabled: true,
    revision: 1,
    providerId: provider.id,
    contextWindow: matches[0]?.contextWindow ?? provider.contextWindows?.[model],
    nonReasoning: matches[0]?.nonReasoning ?? provider.nonReasoningModels?.includes(model),
    codexReasoning:
      matches[0]?.codexReasoning ??
      provider.codexReasoningByModel?.[model] ??
      provider.codexReasoning,
  };
  const snapshot: CatalogSnapshot = {
    scope: 'task',
    agent,
    models: [binding],
    providers: [
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        endpoints: provider.endpoints,
        models: [],
      },
    ],
  };
  if (agent === 'codex' && !agentUpstreamProtocol(binding, agent))
    throw new Error(codexNativeRouteRequired);
  if (!agentUpstreamProtocol(binding, agent))
    throw new Error('This supplier model has no compatible agent protocol.');
  return snapshot;
}
