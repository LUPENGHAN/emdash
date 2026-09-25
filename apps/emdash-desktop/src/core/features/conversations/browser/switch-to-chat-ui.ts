import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { Conversation } from '@core/primitives/conversations/api';

/** Providers whose chat UI (ACP) adapter can load an existing session by id. */
const CHAT_RESUMABLE_PROVIDERS = new Set(['claude', 'codex', 'opencode']);

/**
 * Whether a terminal conversation's session can be reopened in the chat UI. Its session
 * id must be the provider's real one: Claude is spawned with `--session-id <conversation
 * id>`, so that placeholder is real; other providers only have a real id once captured.
 */
export function canSwitchToChatUi(conversation: Conversation): boolean {
  const sessionId = conversation.sessionId;
  return (
    conversation.type !== 'acp' &&
    CHAT_RESUMABLE_PROVIDERS.has(conversation.providerId) &&
    !!sessionId &&
    (conversation.providerId === 'claude' || sessionId !== conversation.id)
  );
}

/**
 * Reopens a terminal conversation's session in the chat UI: the terminal conversation is
 * removed first (killing its CLI, so two processes never write one session), then a chat
 * conversation loads the same session with ACP session/load. Provider session files are
 * untouched either way, so a failure leaves the session resumable from History.
 */
export async function switchConversationToChatUi(conversation: Conversation): Promise<string> {
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const sessionId = conversation.sessionId;
  if (!sessionId) throw new Error('The conversation has no session to load');

  await manager.deleteConversation(conversation.id);
  const created = await manager.createConversation({
    id: crypto.randomUUID(),
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: conversation.providerId,
    title: conversation.title,
    type: 'acp',
    providerSessionId: sessionId,
    isInitialConversation: conversation.isInitialConversation ?? undefined,
  });
  return created.id;
}
