import { describe, expect, it } from 'vitest';
import { removalBlocker, type RemovalConversation } from './task-removal';

const task = { id: 't2', name: 'fix-login', type: 'task' } as const;
const callerTaskId = 't1';

function conversations(overrides: Partial<RemovalConversation>[]): RemovalConversation[] {
  return overrides.map((conversation) => ({
    taskId: 't2',
    agentStatus: 'idle' as const,
    ...conversation,
  }));
}

describe('removalBlocker', () => {
  it('allows a task that is neither the caller nor running', () => {
    expect(
      removalBlocker({ task, callerTaskId, conversations: conversations([{ taskId: 'other' }]) })
    ).toBeNull();
  });

  it('refuses the task the agent is running in', () => {
    expect(removalBlocker({ task: { ...task, id: 't1' }, callerTaskId, conversations: [] })).toBe(
      'You cannot archive or delete the task you are running in.'
    );
  });

  it('refuses a task with an agent working or waiting for input', () => {
    for (const agentStatus of ['working', 'awaiting-input'] as const) {
      expect(
        removalBlocker({ task, callerTaskId, conversations: conversations([{ agentStatus }]) })
      ).toBe('An agent is still running in “fix-login”. Stop it first.');
    }
  });

  it('refuses automation runs', () => {
    expect(
      removalBlocker({
        task: { ...task, type: 'automation-run' },
        callerTaskId,
        conversations: [],
      })
    ).toBe('Automation runs are managed by their automation.');
  });
});
