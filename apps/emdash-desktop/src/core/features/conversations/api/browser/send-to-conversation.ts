import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import type { ConversationManagerStore } from '@core/features/conversations/api/browser/conversation-manager';
import type { Conversation } from '@core/primitives/conversations/api';

/**
 * Sends a message to a conversation's agent as if typed there: a chat takes it as a
 * prompt (queued while a turn runs), a terminal gets it typed and entered.
 */
export async function sendToConversation(
  manager: ConversationManagerStore,
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.type === 'acp') {
    const result = await (
      await getConversationsClient()
    ).acp.sendPrompt(
      {
        conversationId: conversation.id,
        promptId: crypto.randomUUID(),
        prompt: { text },
        placement: 'auto',
      },
      { timeoutMs: 0 }
    );
    if (!result.success) throw new Error('The chat did not accept the message');
    return;
  }
  const session = manager.sessions.get(conversation.id);
  if (!session) throw new Error('That terminal conversation is not running');
  await session.connect();
  if (!session.pty) throw new Error('That terminal conversation is not running');
  session.pty.sendInput(`${text}\r`);
}
