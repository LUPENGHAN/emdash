import { toast } from '@emdash/ui/react/primitives';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { Conversation, ConversationType } from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';

/** Providers whose session ids resume both in the CLI (--resume) and in ACP (session/load). */
const SWITCHABLE_PROVIDERS = new Set(['claude', 'codex', 'opencode']);

/** The UI a conversation would switch to: terminal ⇄ chat. */
export function switchTarget(conversation: Conversation): ConversationType {
  return conversation.type === 'acp' ? 'pty' : 'acp';
}

/**
 * Whether a conversation's session can be reopened in the other UI. Its session id must
 * be the provider's real one: chat (ACP) ids always are; for terminals, Claude is spawned
 * with `--session-id <conversation id>` so that placeholder is real, while other
 * providers only have a real id once captured.
 */
export function canSwitchConversationUi(conversation: Conversation): boolean {
  const sessionId = conversation.sessionId;
  if (!sessionId || !SWITCHABLE_PROVIDERS.has(conversation.providerId)) return false;
  if (conversation.type === 'acp') return true;
  return conversation.providerId === 'claude' || sessionId !== conversation.id;
}

/**
 * Reopens a conversation's session in the other UI. The current conversation is removed
 * first (killing its agent, so two processes never write one session), then a new one of
 * the other type resumes the same session: terminal via --resume, chat via session/load.
 * Provider session files are untouched, so a failure leaves it resumable from History.
 */
export async function switchConversationUi(
  conversation: Conversation
): Promise<{ conversationId: string; type: ConversationType }> {
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const sessionId = conversation.sessionId;
  if (!sessionId) throw new Error('The conversation has no session to resume');
  const type = switchTarget(conversation);

  await manager.deleteConversation(conversation.id);
  const created = await manager.createConversation({
    id: crypto.randomUUID(),
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: conversation.providerId,
    title: conversation.title,
    type,
    providerSessionId: sessionId,
    isInitialConversation: conversation.isInitialConversation ?? undefined,
  });
  return { conversationId: created.id, type };
}

/** Tab-menu entry point: switch, then open the replacement where the old tab was. */
export async function switchConversationUiAndOpen(conversation: Conversation): Promise<void> {
  try {
    const { conversationId, type } = await switchConversationUi(conversation);
    getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
      type === 'acp' ? 'acp-chat' : 'conversation',
      { conversationId },
      { preview: false }
    );
  } catch (error) {
    log.error('switch conversation UI failed', error);
    toast.error(`Could not reopen this session: ${String(error)}`);
  }
}

/** Tab-menu command for a conversation, or none when it cannot switch. */
export function switchConversationUiCommands(conversation: Conversation | undefined) {
  if (!conversation || !canSwitchConversationUi(conversation)) return [];
  return [
    {
      id: 'conversation:switch-ui',
      label: switchTarget(conversation) === 'acp' ? 'Switch to chat UI' : 'Switch to terminal',
      group: 'edit',
      run: () => void switchConversationUiAndOpen(conversation),
    },
  ];
}
