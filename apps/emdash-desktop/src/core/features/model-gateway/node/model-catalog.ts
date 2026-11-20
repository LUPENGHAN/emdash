import { createHash } from 'node:crypto';
import type { ModelProvider, ProviderProtocol } from '@core/features/model-providers/api';
import {
  configuredProtocols,
  modelAvailableForAgent,
  upstreamProtocol,
  type GatewayModel,
} from '../api/model-catalog';
import type { ApiProvider } from './config';

export type CatalogSnapshot = {
  scope?: 'task';
  agent: string;
  claudeUpstreamProtocol?: ProviderProtocol;
  models: GatewayModel[];
  providers: ModelProvider[];
};

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function snapshotCatalog(
  models: GatewayModel[],
  providers: ModelProvider[],
  agent: string
): CatalogSnapshot {
  const available = models.filter((model) =>
    modelAvailableForAgent(
      model,
      providers.find((p) => p.id === model.providerId),
      agent
    )
  );
  return {
    agent,
    models: available,
    providers: providers
      .filter((provider) => available.some((model) => model.providerId === provider.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        protocol: p.protocol,
        endpoints: p.endpoints,
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
  return {
    ...snapshot,
    claudeUpstreamProtocol: protocol,
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
  for (const model of snapshot.models) {
    const saved = snapshot.providers.find((p) => p.id === model.providerId);
    const current = inventory.find((p) => p.id === model.providerId);
    const runtime = providers.find((p) => p.id === model.providerId);
    if (!saved || !current || !runtime || connectionIdentity(saved) !== connectionIdentity(current))
      continue;
    const id = runtimeProviderId(model, saved);
    const mapping = Object.fromEntries(
      Object.entries(model.protocolModels).map(([protocol, binding]) => [
        protocol,
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

/** Deterministic migration preview; publishing requires the user to check model protocols. */
export function migrationPreview(providers: ModelProvider[]): GatewayModel[] {
  const counts = new Map<string, number>();
  for (const p of providers.filter((p) => !p.account))
    for (const m of p.models) counts.set(m, (counts.get(m) ?? 0) + 1);
  return providers
    .filter((p) => !p.account)
    .flatMap((p) =>
      p.models.map((model) => {
        const id = fingerprint([p.id, model]).slice(0, 12);
        const base =
          model.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'model';
        const alias = counts.get(model) === 1 && base === model ? base : `${base}-${id}`;
        return {
          id: `import-${id}`,
          alias,
          name: model,
          enabled: true,
          revision: 1,
          providerId: p.id,
          protocolModels: Object.fromEntries(
            configuredProtocols(p).map((protocol) => [
              protocol,
              { upstreamModel: p.modelAliases?.[model] ?? model },
            ])
          ),
          protocolPolicy: { mode: 'auto' as const },
          contextWindow: p.contextWindows?.[model],
          nonReasoning: p.nonReasoningModels?.includes(model),
          webSearch: p.webSearchModels?.includes(model),
          codexReasoning: p.codexReasoningByModel?.[model] ?? p.codexReasoning,
        };
      })
    );
}

/** Builds a private catalog without publishing or changing any global alias. */
export function taskModelCatalog(
  provider: ModelProvider,
  model: string,
  agent: string,
  published: GatewayModel[]
): CatalogSnapshot {
  if (provider.account) throw new Error('Select an API supplier for a task gateway route.');
  if (!model.trim()) throw new Error('Specify a supplier model for this task.');
  const matches = published.filter(
    (entry) =>
      entry.providerId === provider.id &&
      Object.values(entry.protocolModels).some((mapping) => mapping.upstreamModel === model)
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
        protocols.map((protocol) => [
          protocol,
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
  const snapshot = snapshotCatalog([binding], [provider], agent);
  if (!snapshot.models.length)
    throw new Error('This supplier model has no compatible agent protocol.');
  return { ...snapshot, scope: 'task' };
}
