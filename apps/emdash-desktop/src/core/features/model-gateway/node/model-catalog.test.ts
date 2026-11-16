import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import {
  gatewayModelsSettingsSchema,
  upstreamProtocol,
  type GatewayModel,
} from '../api/model-catalog';
import {
  catalogBindings,
  migrationPreview,
  runtimeCatalog,
  snapshotCatalog,
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

describe('model-first routing', () => {
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
    const snapshot = snapshotCatalog([model], [provider], 'claude');
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
        snapshotCatalog([{ ...model, name: 'Rename', revision: 2 }], [provider], 'claude')
      )
    ).toBe(catalogBindings(snapshot));
    expect(
      catalogBindings(snapshotCatalog([{ ...model, contextWindow: 32000 }], [provider], 'claude'))
    ).not.toBe(catalogBindings(snapshot));
  });

  it('does not publish a model on provider protocols absent from its configuration', () => {
    const restricted = { ...provider, endpoints: undefined, protocol: 'openai-responses' as const };
    expect(snapshotCatalog([model], [restricted], 'claude').models).toEqual([]);
    expect(
      snapshotCatalog(
        [{ ...model, protocolModels: { 'openai-responses': { upstreamModel: 'r' } } }],
        [restricted],
        'codex'
      ).models
    ).toHaveLength(1);
  });

  it('generates repeatable collision-free previews without merging providers', () => {
    const inventory = [provider, { ...provider, id: 'other' }];
    const first = migrationPreview(inventory);
    expect(first).toEqual(migrationPreview(inventory));
    expect(new Set(first.map((m) => m.alias)).size).toBe(2);
    expect(first.map((m) => m.providerId)).toEqual(['p', 'other']);
    expect(gatewayModelsSettingsSchema.safeParse({ version: 1, models: first }).success).toBe(true);
    expect(
      gatewayModelsSettingsSchema.safeParse({
        version: 1,
        models: [model, { ...model, id: 'other' }],
      }).success
    ).toBe(false);
  });
});
