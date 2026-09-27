import { and, eq } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';
import type { AgentCaller } from '../api';

/** The task-linked conversation behind an MCP call, with its working directory. */
export async function resolveAgentCaller(
  db: AppDb,
  resolveWorkspacePath: (workspaceId: string) => Promise<string | null>,
  conversationId: string
): Promise<AgentCaller | null> {
  const [row] = await db
    .select({
      projectId: conversations.projectId,
      taskId: conversations.taskId,
      providerId: conversations.provider,
      title: conversations.title,
      workspaceId: tasks.workspaceId,
    })
    .from(conversations)
    .leftJoin(
      tasks,
      and(eq(tasks.id, conversations.taskId), eq(tasks.projectId, conversations.projectId))
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row?.projectId || !row.taskId || !row.providerId) return null;
  return {
    conversationId,
    projectId: row.projectId,
    taskId: row.taskId,
    providerId: row.providerId,
    title: row.title,
    cwd: row.workspaceId ? await resolveWorkspacePath(row.workspaceId).catch(() => null) : null,
  };
}
