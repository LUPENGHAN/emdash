import { eq } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import type { ImportableSession } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';
import type { ConversationWorkspaceIdentityResolver } from './createConversation';
import { listExternalSessions } from './external-sessions';

/**
 * Sessions in a task's workspace directory that were started outside Emdash and can be
 * adopted as terminal conversations. Sessions already backing a live conversation are
 * left out, as are Emdash's own spawns (their handle is the conversation id).
 */
export async function listImportableSessions(
  db: Pick<AppDb, 'select'>,
  workspaceIdentity: ConversationWorkspaceIdentityResolver,
  taskId: string,
  list: typeof listExternalSessions = listExternalSessions
): Promise<ImportableSession[]> {
  const [taskRow] = await db
    .select({ workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const identity = taskRow?.workspaceId
    ? await workspaceIdentity.resolve(taskRow.workspaceId)
    : null;
  // Session stores are read from this machine's disk; remote workspaces are not covered.
  if (!identity || identity.host.type === 'remote') return [];

  const known = await db
    .select({ id: conversations.id, providerSessionId: conversations.providerSessionId })
    .from(conversations)
    .where(liveConversations());
  const exclude = new Set<string>();
  for (const row of known) {
    exclude.add(row.id);
    if (row.providerSessionId) exclude.add(row.providerSessionId);
  }
  return list(identity.path, { exclude });
}
