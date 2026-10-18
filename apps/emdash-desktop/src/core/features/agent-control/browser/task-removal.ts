import type { Conversation } from '@core/primitives/conversations/api/conversations';
import type { Task } from '@core/primitives/tasks/api';

/** The project conversations an archive/delete check needs; taskId and agent status. */
export type RemovalConversation = {
  taskId: string;
  agentStatus?: Conversation['agentStatus'];
};

/**
 * Why an agent may not archive or delete this task, or null when it may. Enforced on
 * every call in the renderer — the rules do not depend on the agent behaving.
 */
export function removalBlocker(input: {
  task: Pick<Task, 'id' | 'name' | 'type'>;
  callerTaskId: string;
  conversations: readonly RemovalConversation[];
}): string | null {
  const { task, callerTaskId, conversations } = input;
  if (task.id === callerTaskId) {
    return 'You cannot archive or delete the task you are running in.';
  }
  if (task.type === 'automation-run') {
    return 'Automation runs are managed by their automation.';
  }
  const running = conversations.some(
    (conversation) =>
      conversation.taskId === task.id &&
      (conversation.agentStatus === 'working' || conversation.agentStatus === 'awaiting-input')
  );
  if (running) {
    return `An agent is still running in “${task.name}”. Stop it first.`;
  }
  return null;
}
