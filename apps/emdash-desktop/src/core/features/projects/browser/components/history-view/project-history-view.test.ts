import { describe, expect, it, vi } from 'vitest';
import { sessionLocationLabel } from './project-history-view';

vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
}));

describe('sessionLocationLabel', () => {
  const project = '/Users/me/code/app';

  it('says nothing for the project directory itself', () => {
    expect(sessionLocationLabel(project, project)).toBeNull();
  });

  it('names the tool that owns a worktree', () => {
    expect(sessionLocationLabel(`${project}/.claude/worktrees/voice`, project)).toBe(
      'Claude worktree · voice'
    );
    expect(sessionLocationLabel('/Users/me/.codex/worktrees/7add/app', project)).toBe(
      'Codex worktree · app'
    );
    expect(sessionLocationLabel('/Users/me/emdash/worktrees/app-1a2b/emdash-bug', project)).toBe(
      'Emdash worktree · emdash-bug'
    );
    expect(sessionLocationLabel('/tmp/elsewhere/wt', project)).toBe('Worktree · wt');
  });
});
