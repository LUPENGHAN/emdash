import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { toast } from '@emdash/ui/react/primitives';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
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
 * Hands a conversation's work to another agent in the same task: a new conversation of
 * the same UI type starts with a short handoff message (original ask, last reply, git
 * state, and the path of a text-only transcript it can read on demand). The source is
 * kept, retitled "→ <agent>", so it can be picked up again once its quota resets.
 */
export async function handOffConversation(
  conversation: Conversation,
  target: { id: AgentProviderId; name: string }
): Promise<void> {
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const { prompt } = await (
    await getConversationsClient()
  ).prepareHandoff({ conversationId: conversation.id });

  const type = conversation.type ?? 'pty';
  const created = await manager.createConversation({
    id: crypto.randomUUID(),
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: target.id,
    title: conversation.title,
    type,
    ...(type === 'acp' ? { initialQueue: [{ text: prompt }] } : { initialPrompt: prompt }),
  });

  const marker = ` → ${target.name}`;
  if (!conversation.title.endsWith(marker)) {
    const base = conversation.title.slice(0, MAX_CONVERSATION_TITLE_LENGTH - marker.length);
    await manager.renameConversation(conversation.id, `${base}${marker}`);
  }

  getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
    type === 'acp' ? 'acp-chat' : 'conversation',
    { conversationId: created.id },
    { preview: false }
  );
}

/** Tab-menu commands: one "Hand off to …" per other agent. */
export function handoffCommands(conversation: Conversation | undefined) {
  if (!conversation) return [];
  return HANDOFF_TARGETS.filter((target) => target.id !== conversation.providerId).map(
    (target) => ({
      id: `conversation:handoff-${target.id}`,
      label: `Hand off to ${target.name}`,
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
