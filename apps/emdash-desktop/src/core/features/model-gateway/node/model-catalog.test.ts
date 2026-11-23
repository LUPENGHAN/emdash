import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import {
  gatewayModelsSettingsSchema,
  migrateGatewayModelsV1,
  upstreamProtocol,
  type GatewayModel,
} from '../api/model-catalog';
import {
  catalogBindings,
  migrationPreview,
  runtimeCatalog,
  snapshotCatalog,
  taskModelCatalog,
} from './model-catalog';
import { gatewayProviders } from './provider-inventory';

const provider: ModelProvider = {
  id: 'p',
  name: 'Provider',
  baseUrl: 'http://127.0.0.1:1234',
  models: ['physical'],
  endpoints: { anthropic: '', 'openai-chat': '', 'openai-responses': '' },
};
const model: GatewayModel = {
  id: 'm',
  alias: 'public',
  name: 'Public model',
  enabled: true,
  revision: 1,
  providerId: 'p',
  protocolPolicy: { mode: 'auto' },
  protocolModels: {
    anthropic: { upstreamModel: 'native-claude' },
    'openai-chat': { upstreamModel: 'native-chat' },
    'openai-responses': { upstreamModel: 'native-responses' },
  },
};
const published = migrateGatewayModelsV1({ version: 1, models: [model] }).models[0]!;

describe('model-first routing', () => {
  it('migrates every legacy route losslessly without merging models or sources', () => {
    const legacy = {
      version: 1 as const,
      models: [
        model,
        {
          ...model,
          id: 'm-2',
          alias: 'public-two',
          name: 'Public model two',
          providerId: 'other',
          enabled: false,
          revision: 3,
        },
      ],
    };
    const migrated = gatewayModelsSettingsSchema.parse(legacy);

    expect(migrated).toMatchObject({
      version: 2,
      migration: { fromVersion: 1 },
      ignoredSourceIds: [],
      legacyModels: legacy.models,
    });
    expect(migrated.models).toHaveLength(2);
    expect(migrated.models[0]).toMatchObject({
      id: model.id,
      primaryAlias: model.alias,
      displayName: model.name,
      state: 'active',
      revision: model.revision,
      sources: [
        {
          providerId: model.providerId,
          protocolModels: model.protocolModels,
          protocolPolicy: model.protocolPolicy,
        },
      ],
    });
    expect(migrated.models[1]).toMatchObject({ state: 'disabled', revision: 3 });
  });

  it('uses the explicitly selected source per inbound protocol and never silently falls back', () => {
    const anthropicSource = {
      ...published.sources[0]!,
      id: 'anthropic-source',
      providerId: 'anthropic-provider',
      protocolModels: { anthropic: { upstreamModel: 'claude-physical' } },
    };
    const responsesSource = {
      ...published.sources[0]!,
      id: 'responses-source',
      providerId: 'responses-provider',
      protocolModels: { 'openai-responses': { upstreamModel: 'codex-physical' } },
    };
    const multiSource = {
      ...published,
      sources: [anthropicSource, responsesSource],
      activeSourceByProtocol: {
        anthropic: anthropicSource.id,
        'openai-responses': responsesSource.id,
      },
    };
    const providers: ModelProvider[] = [
      {
        ...provider,
        id: 'anthropic-provider',
        protocol: 'anthropic',
        endpoints: undefined,
      },
      {
        ...provider,
        id: 'responses-provider',
        protocol: 'openai-responses',
        endpoints: undefined,
      },
    ];

    expect(snapshotCatalog([multiSource], providers, 'claude').models[0]).toMatchObject({
      providerId: 'anthropic-provider',
      sourceId: 'anthropic-source',
    });
    expect(snapshotCatalog([multiSource], providers, 'codex').models[0]).toMatchObject({
      providerId: 'responses-provider',
      sourceId: 'responses-source',
    });
    expect(
      snapshotCatalog(
        [
          {
            ...multiSource,
            sources: [anthropicSource, { ...responsesSource, enabled: false }],
          },
        ],
        providers,
        'codex'
      ).models
    ).toEqual([]);
  });

  it('keeps old public aliases resolvable while new snapshots publish the primary alias', () => {
    const renamed = {
      ...published,
      primaryAlias: 'public-renamed',
      legacyAliases: ['public'],
    };
    const snapshot = snapshotCatalog([renamed], [provider], 'claude', 'public');

    expect(snapshot.models.map((entry) => entry.alias)).toEqual(['public-renamed', 'public']);
    expect(snapshot.models.every((entry) => entry.id === renamed.id)).toBe(true);
  });

  it('builds private task routes without changing public aliases or inferring unknown mappings', () => {
    const before = structuredClone(model);
    const snapshot = taskModelCatalog(provider, 'native-claude', 'claude', [published]);
    expect(snapshot.models[0]).toMatchObject({
      alias: 'task-model',
      providerId: 'p',
      protocolModels: model.protocolModels,
    });
    expect(model).toEqual(before);
    expect(() => taskModelCatalog(provider, 'unknown', 'claude', [])).toThrow('protocol mappings');
    const single = { ...provider, endpoints: undefined, protocol: 'anthropic' as const };
    expect(taskModelCatalog(single, 'unlisted', 'claude', []).models[0].protocolModels).toEqual({
      anthropic: { upstreamModel: 'unlisted' },
    });
    expect(() =>
      taskModelCatalog({ ...single, protocol: 'openai-responses' }, 'unlisted', 'claude', [])
    ).toThrow('compatible agent protocol');
  });
  it('prefers each agent’s native protocol and converts only supported directions', () => {
    expect(upstreamProtocol(model, 'anthropic')).toBe('anthropic');
    expect(upstreamProtocol(model, 'openai-responses')).toBe('openai-responses');
    expect(upstreamProtocol(model, 'openai-chat')).toBe('openai-chat');
    const chat = { ...model, protocolModels: { 'openai-chat': { upstreamModel: 'chat' } } };
    expect(upstreamProtocol(chat, 'anthropic')).toBe('openai-chat');
    expect(upstreamProtocol(chat, 'openai-responses')).toBe('openai-chat');
    expect(
      upstreamProtocol(
        { ...model, protocolModels: { 'openai-responses': { upstreamModel: 'r' } } },
        'anthropic'
      )
    ).toBeNull();
    expect(
      upstreamProtocol(
        { ...model, protocolPolicy: { mode: 'fixed', protocol: 'openai-chat' } },
        'anthropic'
      )
    ).toBe('openai-chat');
  });

  it('keeps physical models, credentials and connection scopes independent', () => {
    const snapshot = snapshotCatalog([published], [provider], 'claude');
    const runtime = (key: string, source = provider) =>
      runtimeCatalog(snapshot, [source], gatewayProviders([{ provider: source, apiKey: key }]));
    const first = runtime('secret-one');
    expect(first.providers[0].route?.protocolModels.public).toEqual({
      anthropic: 'native-claude',
      'openai-chat': 'native-chat',
      'openai-responses': 'native-responses',
    });
    expect(runtime('secret-two').models).toEqual(first.models);
    expect(runtime('secret-two').providers[0].apiKey).toBe('secret-two');
    expect(runtime('secret-two', { ...provider, baseUrl: 'http://127.0.0.1:4321' }).models).toEqual(
      {}
    );
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(
      catalogBindings(
        snapshotCatalog(
          [{ ...published, displayName: 'Rename', revision: 2 }],
          [provider],
          'claude'
        )
      )
    ).toBe(catalogBindings(snapshot));
    expect(
      catalogBindings(
        snapshotCatalog([{ ...published, contextWindow: 32000 }], [provider], 'claude')
      )
    ).not.toBe(catalogBindings(snapshot));
  });

  it('does not publish a model on provider protocols absent from its configuration', () => {
    const restricted = { ...provider, endpoints: undefined, protocol: 'openai-responses' as const };
    expect(snapshotCatalog([published], [restricted], 'claude').models).toEqual([]);
    expect(
      snapshotCatalog(
        [
          {
            ...published,
            sources: [
              {
                ...published.sources[0]!,
                protocolModels: { 'openai-responses': { upstreamModel: 'r' } },
              },
            ],
          },
        ],
        [restricted],
        'codex'
      ).models
    ).toHaveLength(1);
  });

  it('generates repeatable collision-free previews without merging providers', () => {
    const inventory = [provider, { ...provider, id: 'other' }];
    const first = migrationPreview(inventory);
    expect(first).toEqual(migrationPreview(inventory));
    expect(new Set(first.map((m) => m.primaryAlias)).size).toBe(2);
    expect(first.map((m) => m.sources[0]?.providerId)).toEqual(['p', 'other']);
    expect(gatewayModelsSettingsSchema.safeParse({ version: 2, models: first }).success).toBe(true);
    expect(
      gatewayModelsSettingsSchema.safeParse({
        version: 1,
        models: [model, { ...model, id: 'other' }],
      }).success
    ).toBe(false);
  });
});
