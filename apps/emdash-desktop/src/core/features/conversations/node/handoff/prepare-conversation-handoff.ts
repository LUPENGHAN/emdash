import { eq } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { HandoffPreparation } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { prepareHandoff } from './prepare-handoff';

/** Prepares handing a conversation's work to another agent in the same workspace. */
export async function prepareConversationHandoff(
  db: Pick<AppDb, 'select'>,
  conversationId: string
): Promise<HandoffPreparation> {
  const [row] = await db
    .select({
      provider: conversations.provider,
      providerSessionId: conversations.providerSessionId,
      cwd: conversations.cwd,
      location: conversations.location,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row?.cwd || !row.provider) throw new Error('Conversation not found');
  // Session stores and the workspace are read from this machine's disk.
  if (row.location === 'remote') throw new Error('Handoff is only available for local projects');
  return prepareHandoff({
    providerId: row.provider,
    sessionId: row.providerSessionId,
    cwd: row.cwd,
  });
}
