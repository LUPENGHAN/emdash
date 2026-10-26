import { describe, expect, it } from 'vitest';
import {
  applyContextWindowToSelected,
  canApplyContextToSelected,
  claudeRolesForEveryRole,
} from './provider-form-bulk';

describe('provider form bulk fill', () => {
  it('writes one context window onto the selected models and leaves the rest', () => {
    const next = applyContextWindowToSelected({ a: '256k', c: '64k' }, ['a', 'b'], '1m');
    expect(next).toEqual({ a: '1m', b: '1m', c: '64k' });
    expect(canApplyContextToSelected(2, '1m')).toBe(true);
  });

  it('clears context on the selected models when the field is blank', () => {
    const next = applyContextWindowToSelected({ a: '1m', b: '128k', c: '64k' }, ['a', 'b'], '');
    expect(next).toEqual({ a: '', b: '', c: '64k' });
    expect(canApplyContextToSelected(2, '   ')).toBe(true);
  });

  it('refuses a context window that does not parse, and refuses to apply with nothing selected', () => {
    expect(canApplyContextToSelected(2, 'abc')).toBe(false);
    expect(canApplyContextToSelected(0, '1m')).toBe(false);
  });

  it('points every Claude Code role at one model and keeps display names', () => {
    const next = claudeRolesForEveryRole(
      { model: 'kimi', opus: 'glm', names: { opus: 'Kimi' } },
      'glm'
    );
    expect(next).toEqual({
      model: 'glm',
      opus: 'glm',
      sonnet: 'glm',
      haiku: 'glm',
      fable: 'glm',
      subagent: 'glm',
      names: { opus: 'Kimi' },
    });
  });
});
