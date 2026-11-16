import { createHash } from 'node:crypto';
import type { ModelProvider } from '@core/features/model-providers/api';
import {
  configuredProtocols,
  modelAvailableForAgent,
  type GatewayModel,
} from '../api/model-catalog';
import type { ApiProvider } from './config';

export type CatalogSnapshot = {
  agent: string;
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
