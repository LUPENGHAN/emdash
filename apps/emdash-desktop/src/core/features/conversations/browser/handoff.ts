import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { toast } from '@emdash/ui/react/primitives';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { openModal } from '@core/manifests/browser/modal-api';
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  type Conversation,
} from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';

const HANDOFF_TARGETS: { id: AgentProviderId; name: string }[] = [
  { id: 'claude' as AgentProviderId, name: 'Claude' },
  { id: 'codex' as AgentProviderId, name: 'Codex' },
  { id: 'opencode' as AgentProviderId, name: 'OpenCode' },
  { id: 'pi' as AgentProviderId, name: 'Pi' },
  { id: 'oh-my-pi' as AgentProviderId, name: 'Oh My Pi' },
  // A target only receives the handoff message, so it needs no transcript reader.
  { id: 'cursor' as AgentProviderId, name: 'Cursor' },
];

/**
 * Hands a conversation's work to another agent in the same task. The new-conversation
 * dialog opens on the target agent so its model and source can be chosen; on confirm the
 * new conversation (same UI type where the target has it) starts with a short handoff
 * message (original ask, last reply, git state, and the path of a text-only transcript it
 * can read on demand). The source is kept, retitled "→ <agent>", so it can be picked up
 * again once its quota resets.
 */
export async function handOffConversation(
  conversation: Conversation,
  target: { id: AgentProviderId; name: string }
): Promise<void> {
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const outcome = await openModal('createConversationModal', {
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    handoff: {
      fromConversationId: conversation.id,
      providerId: target.id,
      type: conversation.type ?? 'pty',
      title: conversation.title,
    },
  });
  if (!outcome.success) return;

  // The dialog may have switched agents; name the one that took over.
  const created = manager.conversations.get(outcome.data.conversationId)?.data;
  const targetName =
    HANDOFF_TARGETS.find((candidate) => candidate.id === created?.providerId)?.name ??
    created?.providerId ??
    target.name;
  const marker = ` → ${targetName}`;
  if (!conversation.title.endsWith(marker)) {
    const base = conversation.title.slice(0, MAX_CONVERSATION_TITLE_LENGTH - marker.length);
    await manager.renameConversation(conversation.id, `${base}${marker}`);
  }

  getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
    outcome.data.type === 'acp' ? 'acp-chat' : 'conversation',
    { conversationId: outcome.data.conversationId },
    { preview: false }
  );
}

/** Tab-menu commands: one "Hand off to …" per other agent. */
export function handoffCommands(conversation: Conversation | undefined) {
  if (!conversation) return [];
  return HANDOFF_TARGETS.filter((target) => target.id !== conversation.providerId).map(
    (target) => ({
      id: `conversation:handoff-${target.id}`,
      label: `Hand off to ${target.name}…`,
      group: 'handoff',
      run: () => {
        void handOffConversation(conversation, target).catch((error: unknown) => {
          log.error('conversation handoff failed', error);
          toast.error(`Could not hand off to ${target.name}: ${String(error)}`);
        });
      },
    })
  );
}
