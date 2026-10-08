import { homedir } from 'node:os';
import { and, eq, isNotNull } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { adoptLegacyCursorSession } from './cursor-sessions';

/**
 * Before a Cursor terminal created by an older Emdash resumes (one created before
 * `namedSince`, when Emdash began naming Cursor sessions by conversation id), gives it
 * back the session a bare `--resume` would have continued. See `adoptLegacyCursorSession`.
 */
export async function resumeLegacyCursorConversation(params: {
  db: Pick<AppDb, 'select'>;
  conversationId: string;
  sessionId: string;
  cwd: string;
  namedSince: Date;
}): Promise<boolean> {
  const [row] = await params.db
    .select({ createdAt: conversations.createdAt, provider: conversations.provider })
    .from(conversations)
    .where(eq(conversations.id, params.conversationId))
    .limit(1);
  if (row?.provider !== 'cursor') return false;
  const createdAt = Date.parse(row.createdAt);
  if (!(createdAt < params.namedSince.getTime())) return false;
  const claimed = await params.db
    .select({ sessionId: conversations.providerSessionId })
    .from(conversations)
    .where(and(eq(conversations.provider, 'cursor'), isNotNull(conversations.providerSessionId)));
  return adoptLegacyCursorSession(
    { home: homedir(), env: process.env },
    params.sessionId,
    params.cwd,
    new Set(claimed.flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])))
  );
}
