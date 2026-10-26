import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projectFolders, projects } from '@core/services/app-db/node/schema';

const RESERVED_FOLDER_NAME = 'archived';
const MAX_FOLDER_NAME_LENGTH = 64;

export type ProjectFolderRecord = {
  id: string;
  name: string;
};

export function normalizeFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error('Folder name must be 1 to 64 characters.');
  }
  if (trimmed.toLowerCase() === RESERVED_FOLDER_NAME) {
    throw new Error('Folder name Archived is reserved.');
  }
  return trimmed;
}

export async function listProjectFolders(db: AppDb): Promise<ProjectFolderRecord[]> {
  const rows = await db
    .select({ id: projectFolders.id, name: projectFolders.name })
    .from(projectFolders)
    .orderBy(projectFolders.name);
  return rows;
}

export async function createProjectFolder(
  db: AppDb,
  name: string,
  projectId?: string
): Promise<ProjectFolderRecord> {
  const nextName = normalizeFolderName(name);
  await assertFolderNameAvailable(db, nextName);
  const now = new Date().toISOString();
  const folder = { id: randomUUID(), name: nextName };

  db.transaction((tx) => {
    tx.insert(projectFolders)
      .values({ ...folder, createdAt: now, updatedAt: now })
      .run();
    if (!projectId) return;
    const moved = tx
      .update(projects)
      .set({ folderId: folder.id, updatedAt: now })
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .returning({ id: projects.id })
      .all();
    if (moved.length === 0) throw new Error(`Project ${projectId} not found`);
  });

  appDbPokes.projects.poke(projectId ? { projectId } : {});
  return folder;
}

export async function renameProjectFolder(
  db: AppDb,
  folderId: string,
  name: string
): Promise<void> {
  const nextName = normalizeFolderName(name);
  await assertFolderNameAvailable(db, nextName, folderId);
  const now = new Date().toISOString();
  const updated = await db
    .update(projectFolders)
    .set({ name: nextName, updatedAt: now })
    .where(eq(projectFolders.id, folderId))
    .returning({ id: projectFolders.id });
  if (updated.length === 0) throw new Error('Folder not found');
  appDbPokes.projects.poke({});
}

/**
 * Removes the folder row and ungroups its projects. Projects stay in the working
 * list; nothing on disk is removed.
 */
export async function deleteProjectFolder(db: AppDb, folderId: string): Promise<void> {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(projects)
      .set({ folderId: null, updatedAt: now })
      .where(eq(projects.folderId, folderId))
      .run();
    const deleted = tx
      .delete(projectFolders)
      .where(eq(projectFolders.id, folderId))
      .returning({ id: projectFolders.id })
      .all();
    if (deleted.length === 0) throw new Error('Folder not found');
  });
  appDbPokes.projects.poke({});
}

export async function moveProjectToFolder(
  db: AppDb,
  projectId: string,
  folderId: string | null
): Promise<void> {
  if (folderId) {
    const [folder] = await db
      .select({ id: projectFolders.id })
      .from(projectFolders)
      .where(eq(projectFolders.id, folderId))
      .limit(1);
    if (!folder) throw new Error('Folder not found');
  }

  const now = new Date().toISOString();
  const updated = await db
    .update(projects)
    .set({ folderId, updatedAt: now })
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .returning({ id: projects.id });
  if (updated.length === 0) throw new Error(`Project ${projectId} not found`);
  appDbPokes.projects.poke({ projectId });
}

async function assertFolderNameAvailable(
  db: AppDb,
  name: string,
  exceptFolderId?: string
): Promise<void> {
  const rows = await db
    .select({ id: projectFolders.id })
    .from(projectFolders)
    .where(sql`lower(${projectFolders.name}) = ${name.toLowerCase()}`);
  if (rows.some((row) => row.id !== exceptFolderId)) {
    throw new Error('A folder with this name already exists.');
  }
}
