import { eq } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { HandoffPreparation } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import {
  handoffSummaryRequest,
  prepareHandoff,
  readHandoffSummary,
  type HandoffExtras,
} from './prepare-handoff';

/** A conversation on this computer: its agent, session and workspace. */
export async function localConversation(db: Pick<AppDb, 'select'>, conversationId: string) {
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
  return { ...row, cwd: row.cwd, provider: row.provider };
}

/** Prepares handing a conversation's work to another agent in the same workspace. */
export async function prepareConversationHandoff(
  db: Pick<AppDb, 'select'>,
  conversationId: string,
  extra: HandoffExtras = {}
): Promise<HandoffPreparation> {
  const row = await localConversation(db, conversationId);
  return prepareHandoff(
    { providerId: row.provider, sessionId: row.providerSessionId, cwd: row.cwd },
    undefined,
    extra
  );
}

/** The message asking a conversation's agent for a handoff summary, and where it goes. */
export async function requestConversationHandoffSummary(
  db: Pick<AppDb, 'select'>,
  conversationId: string
): Promise<{ summaryPath: string; prompt: string }> {
  return handoffSummaryRequest((await localConversation(db, conversationId)).cwd);
}

/** The summary a conversation's agent wrote, once finished; null while it is writing. */
export async function readConversationHandoffSummary(
  db: Pick<AppDb, 'select'>,
  conversationId: string,
  summaryPath: string
): Promise<string | null> {
  return readHandoffSummary((await localConversation(db, conversationId)).cwd, summaryPath);
}
