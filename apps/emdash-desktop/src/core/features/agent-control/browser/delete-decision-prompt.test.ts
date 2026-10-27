import { describe, expect, it } from 'vitest';
import { deleteDecisionPrompt } from './delete-decision-prompt';

describe('deleteDecisionPrompt', () => {
  it('names the decision and says the delete cannot be undone', () => {
    expect(deleteDecisionPrompt('Codex (“probe”)', 'Share the list')).toEqual({
      title: 'Codex (“probe”) wants to delete “Share the list”',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
    });
  });
});
