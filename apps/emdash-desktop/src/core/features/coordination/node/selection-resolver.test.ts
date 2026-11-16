import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import { createSelectionResolver } from './selection-resolver';

const provider: ModelProvider = {
  id: 'supplier',
  name: 'Supplier',
  baseUrl: 'http://localhost:1234',
  models: ['code'],
  codexReasoning: { levels: ['low', 'high'], default: 'high' },
};
function resolver(saved?: ProviderCustomConfig) {
  return createSelectionResolver({
    defaultAgent: async () => 'claude',
    getAgentSettings: async () => saved,
    getProviders: async () => [provider],
    getModels: async () => [],
  });
}

describe('coordinator model selection', () => {
  it('shows agent default effort and its source without starting a session', async () => {
    const resolved = await resolver({ effort: 'high' })({});
    expect(resolved.values).toMatchObject({ agent: 'claude', effort: 'high' });
    expect(resolved.sources.effort).toBe('agent-default');
    expect(resolved.errors).toEqual([]);
  });

  it('allows explicit adapter defaults to clear a saved agent effort', async () => {
    const resolved = await resolver({ effort: 'high' })({ effort: null });
    expect(resolved.values.effort).toBeNull();
    expect(resolved.sources.effort).toBe('selection');
  });

  it('filters effort by supplier model capabilities and rejects incompatible selections', async () => {
    const resolved = await resolver()({
      agent: 'codex',
      supplierId: provider.id,
      model: 'code',
      effort: 'medium',
    });
    expect(Object.keys(resolved.effortOptions)).toEqual(['low', 'high']);
    expect(resolved.errors).toEqual([expect.stringContaining('does not support effort medium')]);
  });

  it('rejects unavailable suppliers and official login combined with a supplier', async () => {
    expect((await resolver()({ supplierId: 'missing', model: 'code' })).errors).toContain(
      'The selected API supplier is unavailable.'
    );
    expect(
      (await resolver()({ supplierId: provider.id, connection: 'official', model: 'code' })).errors
    ).toContain('A supplier requires gateway access.');
  });

  it('does not carry a gateway alias into an explicitly selected official session', async () => {
    const resolved = await resolver({
      modelSource: 'gateway:models',
      sourceModel: 'private-alias',
    })({ connection: 'official' });
    expect(resolved.values.model).toBeUndefined();
    expect(resolved.sources.model).toBe('adapter-default');
  });
});
