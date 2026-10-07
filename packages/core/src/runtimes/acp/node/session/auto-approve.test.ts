import { describe, expect, it } from 'vitest';
import { autoApproveOption } from './auto-approve';

describe('autoApproveOption', () => {
  it('allows once where it can, always only where that is the only allow', () => {
    expect(
      autoApproveOption([
        { optionId: 'a', kind: 'allow_always' },
        { optionId: 'o', kind: 'allow_once' },
      ])
    ).toBe('o');
    expect(
      autoApproveOption([
        { optionId: 'a', kind: 'allow_always' },
        { optionId: 'r', kind: 'reject_once' },
      ])
    ).toBe('a');
    expect(autoApproveOption([{ optionId: 'r', kind: 'reject_once' }])).toBeNull();
  });
});
