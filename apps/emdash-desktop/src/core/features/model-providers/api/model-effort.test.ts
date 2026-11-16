import { describe, expect, it } from 'vitest';
import type { ModelProvider } from './index';
import { assertModelEffort, modelEffortOptions } from './model-effort';

const capability = {
  kind: 'selectable',
  effortOptions: { low: { label: 'Low', level: 1 }, high: { label: 'High', level: 3 } },
};
const provider: ModelProvider = {
  id: 'internal',
  name: 'Internal',
  baseUrl: 'http://internal',
  models: ['code'],
  codexReasoning: { levels: ['low'], default: 'low' },
};

it('intersects agent and model restrictions, including an implicit provider model', () => {
  expect(Object.keys(modelEffortOptions(capability, 'codex', provider))).toEqual(['low']);
  expect(
    Object.keys(
      modelEffortOptions(
        capability,
        'codex',
        {
          ...provider,
          codexReasoningByModel: { code: { levels: ['high'], default: 'high' } },
        },
        'code'
      )
    )
  ).toEqual(['high']);
});

describe('effort validation', () => {
  it('allows inherited effort while refusing concrete unsupported values', () => {
    expect(() => assertModelEffort(null, capability, 'codex', provider)).not.toThrow();
    expect(() => assertModelEffort('high', capability, 'codex', provider)).toThrow(
      'does not support'
    );
    expect(() => assertModelEffort('low', capability, 'codex', provider)).not.toThrow();
  });
  it('disables effort for a non-reasoning model and unsupported agents', () => {
    expect(
      modelEffortOptions(capability, 'codex', {
        ...provider,
        nonReasoningModels: ['code'],
      })
    ).toEqual({});
    expect(modelEffortOptions({ kind: 'none' }, 'other')).toEqual({});
  });
});
