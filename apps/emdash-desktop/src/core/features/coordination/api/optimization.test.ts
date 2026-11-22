import { describe, expect, it } from 'vitest';
import {
  canTransitionOptimizationRun,
  optimizationStateTransitions,
  requiresOptimizationConfirmation,
} from './optimization';

describe('optimization state policy', () => {
  it('allows the normal technical and experience-validation path', () => {
    const path = [
      'captured',
      'investigating',
      'planning',
      'implementing',
      'validating',
      'ready_to_apply',
      'applying',
      'observing',
      'accepted',
    ] as const;
    for (let index = 1; index < path.length; index += 1) {
      expect(canTransitionOptimizationRun(path[index - 1], path[index])).toBe(true);
    }
  });

  it('does not let terminal acceptance silently restart work', () => {
    expect(optimizationStateTransitions.accepted).toEqual([]);
    expect(canTransitionOptimizationRun('accepted', 'implementing')).toBe(false);
    expect(canTransitionOptimizationRun('captured', 'accepted')).toBe(false);
  });

  it('requires confirmation for high-risk, dependency and data changes', () => {
    const low = { level: 'low' as const, reasons: [], requiresUserConfirmation: false };
    expect(requiresOptimizationConfirmation(low, 'renderer')).toBe(false);
    expect(requiresOptimizationConfirmation(low, 'main-runtime')).toBe(false);
    expect(requiresOptimizationConfirmation(low, 'dependency')).toBe(true);
    expect(requiresOptimizationConfirmation(low, 'data-migration')).toBe(true);
    expect(
      requiresOptimizationConfirmation({
        level: 'high',
        reasons: ['权限变化'],
        requiresUserConfirmation: true,
      })
    ).toBe(true);
  });
});
