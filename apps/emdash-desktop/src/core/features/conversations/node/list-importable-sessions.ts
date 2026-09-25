import { and, eq, isNotNull } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import {
  liveWorkspaces,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import type { ImportableSession } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects, tasks } from '@core/services/app-db/node/schema';
import type { ConversationWorkspaceIdentityResolver } from './createConversation';
import { listExternalSessions } from './external-sessions';

type ListDb = Pick<AppDb, 'select'>;

/**
 * Sessions in a task's workspace directory that were started outside Emdash and can be
 * adopted as terminal conversations.
 */
export async function listImportableSessions(
  db: ListDb,
  workspaceIdentity: ConversationWorkspaceIdentityResolver,
  taskId: string,
  list: typeof listExternalSessions = listExternalSessions
): Promise<ImportableSession[]> {
  const [taskRow] = await db
    .select({ workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return listForWorkspace(db, workspaceIdentity, taskRow?.workspaceId ?? null, list);
}

/**
 * Sessions started outside Emdash anywhere in a project: its checkout and every live local
 * worktree Emdash knows (its own, plus ones adopted from Claude Code, Codex, …). Each is
 * tagged with its workspace so it can be resumed right there, without a new worktree.
 */
export async function listProjectImportableSessions(
  db: ListDb,
  workspaceIdentity: ConversationWorkspaceIdentityResolver,
  projectId: string,
  list: typeof listExternalSessions = listExternalSessions
): Promise<ImportableSession[]> {
  const [projectRow] = await db
    .select({ workspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const repositoryId = projectRow?.workspaceId;
  const identity = repositoryId ? await workspaceIdentity.resolve(repositoryId) : null;
  // Session stores are read from this machine's disk; remote workspaces are not covered.
  if (!repositoryId || !identity || identity.host.type === 'remote') return [];

  const worktrees = await db
    .select({ id: workspaces.id, path: workspaces.path, location: workspaces.location })
    .from(workspaces)
    .where(and(eq(workspaces.parentId, repositoryId), liveWorkspaces()));
  const workspaceByPath = new Map([[identity.path, repositoryId]]);
  for (const worktree of worktrees) {
    if (worktree.path && worktree.location !== 'remote') {
      workspaceByPath.set(worktree.path, worktree.id);
    }
  }

  const sessions = await list([...workspaceByPath.keys()], {
    exclude: await sessionsInTasks(db),
  });
  return sessions.map((session) => ({
    ...session,
    workspaceId: workspaceByPath.get(session.cwd),
  }));
}

/**
 * Sessions already backing a live conversation in some task are left out, as are
 * Emdash's own spawns (their handle is the conversation id). A conversation whose task
 * was deleted (kept, but unlinked) no longer hides its session: it is reachable from
 * nowhere else, so it must be resumable again.
 */
async function listForWorkspace(
  db: ListDb,
  workspaceIdentity: ConversationWorkspaceIdentityResolver,
  workspaceId: string | null,
  list: typeof listExternalSessions
): Promise<ImportableSession[]> {
  const identity = workspaceId ? await workspaceIdentity.resolve(workspaceId) : null;
  // Session stores are read from this machine's disk; remote workspaces are not covered.
  if (!identity || identity.host.type === 'remote') return [];

  return list(identity.path, { exclude: await sessionsInTasks(db) });
}

/** Session handles (and conversation ids) of live conversations that belong to a task. */
async function sessionsInTasks(db: ListDb): Promise<Set<string>> {
  const known = await db
    .select({ id: conversations.id, providerSessionId: conversations.providerSessionId })
    .from(conversations)
    .where(and(liveConversations(), isNotNull(conversations.taskId)));
  const exclude = new Set<string>();
  for (const row of known) {
    exclude.add(row.id);
    if (row.providerSessionId) exclude.add(row.providerSessionId);
  }
  return exclude;
}
