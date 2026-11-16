import { expect, it } from 'vitest';
import { delegationModelSelection } from './model-selection';

it('preserves omitted defaults and maps task-scoped selections without credential values', () => {
  expect(delegationModelSelection({})).toEqual({});
  expect(
    delegationModelSelection({ supplierId: 'internal', model: 'code', effort: 'high' })
  ).toEqual({
    supplierId: 'internal',
    sourceModel: 'code',
    modelSource: 'gateway:models',
    effort: 'high',
  });
  expect(
    delegationModelSelection({ connection: 'official', model: 'native', effort: null })
  ).toEqual({ modelSource: null, model: 'native', sourceModel: 'native', effort: null });
  expect(() =>
    delegationModelSelection({ supplierId: 'internal', connection: 'official' })
  ).toThrow('gateway');
  expect(() => delegationModelSelection({ supplierId: 'internal' })).toThrow('model');
});
