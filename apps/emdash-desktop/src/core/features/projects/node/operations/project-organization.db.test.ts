import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projectFolders, projects, tasks } from '@core/services/app-db/node/schema';
import { archiveProject, restoreProject } from './archiveProject';
import {
  createProjectFolder,
  deleteProjectFolder,
  moveProjectToFolder,
  renameProjectFolder,
} from './project-folders';

describe('project folders and archive', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    await fixture.db.insert(projects).values([
      { id: 'project', name: 'Project', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'other', name: 'Other', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await fixture.db.insert(tasks).values({
      id: 'task',
      projectId: 'project',
      name: 'Task',
      status: 'active',
    });
  });

  afterEach(() => {
    fixture.close();
    vi.restoreAllMocks();
  });

  it('moves a project into a folder and ungroups it when the folder is deleted', async () => {
    const folder = await createProjectFolder(fixture.db, '  Client  ', 'project');
    expect(folder.name).toBe('Client');

    const [moved] = await fixture.db.select().from(projects).where(eq(projects.id, 'project'));
    expect(moved?.folderId).toBe(folder.id);
    expect(moved?.deletedAt).toBeNull();

    await deleteProjectFolder(fixture.db, folder.id);

    const [ungrouped] = await fixture.db.select().from(projects).where(eq(projects.id, 'project'));
    expect(ungrouped?.folderId).toBeNull();
    expect(ungrouped?.deletedAt).toBeNull();
    const remaining = await fixture.db.select().from(projectFolders);
    expect(remaining).toEqual([]);
  });

  it('rejects a folder named Archived and a duplicate name', async () => {
    await expect(createProjectFolder(fixture.db, ' archived ')).rejects.toThrow(
      'Folder name Archived is reserved.'
    );
    const folder = await createProjectFolder(fixture.db, 'Client');
    await expect(renameProjectFolder(fixture.db, folder.id, 'ARCHIVED')).rejects.toThrow(
      'Folder name Archived is reserved.'
    );
    await expect(createProjectFolder(fixture.db, 'client')).rejects.toThrow(
      'A folder with this name already exists.'
    );
    const [kept] = await fixture.db.select().from(projectFolders);
    expect(kept?.name).toBe('Client');
  });

  it('archives without tombstoning the project or its task, then restores the same folder', async () => {
    const folder = await createProjectFolder(fixture.db, 'Personal');
    await moveProjectToFolder(fixture.db, 'project', folder.id);
    const removeProjectDeployments = vi.fn(async () => {});
    const resumeProjectDeployments = vi.fn(async () => {});
    vi.spyOn(appDbPokes.projects, 'poke');

    await archiveProject(fixture.db, { removeProjectDeployments }, 'project');

    const [archived] = await fixture.db.select().from(projects).where(eq(projects.id, 'project'));
    expect(archived?.archivedAt).toEqual(expect.any(String));
    expect(archived?.deletedAt).toBeNull();
    expect(archived?.folderId).toBe(folder.id);
    expect(removeProjectDeployments).toHaveBeenCalledWith('project');

    const [task] = await fixture.db.select().from(tasks).where(eq(tasks.id, 'task'));
    expect(task?.archivedAt).toBeNull();
    expect(task?.deletedAt ?? null).toBeNull();

    await restoreProject(fixture.db, { resumeProjectDeployments }, 'project');

    const [restored] = await fixture.db.select().from(projects).where(eq(projects.id, 'project'));
    expect(restored?.archivedAt).toBeNull();
    expect(restored?.folderId).toBe(folder.id);
    expect(resumeProjectDeployments).toHaveBeenCalledWith('project');
  });

  it('leaves the project unarchived when pulling automations fails', async () => {
    const removeProjectDeployments = vi.fn(async () => {
      throw new Error('runtime down');
    });

    await expect(
      archiveProject(fixture.db, { removeProjectDeployments }, 'project')
    ).rejects.toThrow('runtime down');

    const [row] = await fixture.db.select().from(projects).where(eq(projects.id, 'project'));
    expect(row?.archivedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });
});
