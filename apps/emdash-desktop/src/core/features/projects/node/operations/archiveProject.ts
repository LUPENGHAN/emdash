import { and, eq, isNull } from 'drizzle-orm';
import type { AutomationsService } from '@core/features/automations/api/node/automations-service';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import {
  isLiveSourceRepository,
  LIVE_SOURCE_REPOSITORY_PROTECTED_MESSAGE,
} from '@core/primitives/app-identity/node/live-source-repository';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projects } from '@core/services/app-db/node/schema';

export type ProjectArchiveAutomations = Pick<
  AutomationsService,
  'removeProjectDeployments' | 'resumeProjectDeployments'
>;

/**
 * Sets a project aside. The repository, worktrees, task rows, and any agent that
 * is already running stay as they are. Scheduled automations are pulled off the
 * runtime so a new run does not start; a run that has already started is left
 * to finish. `deleted_at` is not set, and `folder_id` is kept for restore.
 */
export async function archiveProject(
  db: AppDb,
  automations: Pick<ProjectArchiveAutomations, 'removeProjectDeployments'>,
  projectId: string
): Promise<void> {
  const existing = await liveProject(db, projectId);
  if (!existing) throw new Error(`Project ${projectId} not found`);
  if (
    isLiveSourceRepository({
      hostType: existing.repositoryLocation === 'local' ? 'local' : 'remote',
      path: existing.repositoryPath,
    })
  )
    throw new Error(LIVE_SOURCE_REPOSITORY_PROTECTED_MESSAGE);
  if (existing.archivedAt) return;

  const now = new Date().toISOString();
  await db
    .update(projects)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  appDbPokes.projects.poke({ projectId });

  try {
    await automations.removeProjectDeployments(projectId);
  } catch (error) {
    await db
      .update(projects)
      .set({ archivedAt: null, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, projectId));
    appDbPokes.projects.poke({ projectId });
    throw error;
  }
}

/** Puts an archived project back in its folder, or the ungrouped list, and redeploys automations. */
export async function restoreProject(
  db: AppDb,
  automations: Pick<ProjectArchiveAutomations, 'resumeProjectDeployments'>,
  projectId: string
): Promise<void> {
  const existing = await liveProject(db, projectId);
  if (!existing) throw new Error(`Project ${projectId} not found`);
  if (!existing.archivedAt) return;

  const archivedAt = existing.archivedAt;
  const now = new Date().toISOString();
  await db
    .update(projects)
    .set({ archivedAt: null, updatedAt: now })
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  appDbPokes.projects.poke({ projectId });

  try {
    await automations.resumeProjectDeployments(projectId);
  } catch (error) {
    await db
      .update(projects)
      .set({ archivedAt, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, projectId));
    appDbPokes.projects.poke({ projectId });
    throw error;
  }
}

async function liveProject(
  db: AppDb,
  projectId: string
): Promise<
  | {
      archivedAt: string | null;
      repositoryLocation: 'local' | 'remote' | null;
      repositoryPath: string | null;
    }
  | undefined
> {
  const [row] = await db
    .select({
      archivedAt: projects.archivedAt,
      repositoryLocation: workspaces.location,
      repositoryPath: workspaces.path,
    })
    .from(projects)
    .leftJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return row;
}
