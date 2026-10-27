import { describe, expect, it } from 'vitest';
import { deleteRequirementPrompt } from './delete-requirement-prompt';

describe('deleteRequirementPrompt', () => {
  it('names the requirement and how many sub-requirements go with it', () => {
    expect(deleteRequirementPrompt('Codex (“probe”)', 'Parent', 0)).toEqual({
      title: 'Codex (“probe”) wants to delete “Parent”',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
    });
    expect(deleteRequirementPrompt('Codex (“probe”)', 'Parent', 1).description).toBe(
      'This also deletes its 1 sub-requirement. This cannot be undone.'
    );
    expect(deleteRequirementPrompt('Codex (“probe”)', 'Parent', 2).description).toBe(
      'This also deletes its 2 sub-requirements. This cannot be undone.'
    );
  });
});
