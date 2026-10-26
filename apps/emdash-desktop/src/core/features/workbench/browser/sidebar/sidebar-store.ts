import { computed, makeAutoObservable, observable } from 'mobx';
import { type ProjectStore } from '@core/features/projects/api/browser/stores/project';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import { asAvailableProject } from '@core/features/projects/api/browser/stores/project-selectors';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import {
  workbenchSidebarMemento,
  type WorkbenchSidebarState,
} from '@core/features/workbench/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import {
  registeredTaskData,
  unregisteredTaskData,
} from '@core/primitives/task-state/browser/task-state';
export type SidebarTaskSortBy = WorkbenchSidebarState['taskSortBy'];

export type TaskSortKind = 'created' | 'updated';

export function sortKindFor(sortBy: SidebarTaskSortBy): TaskSortKind {
  return sortBy === 'created-at' ? 'created' : 'updated';
}

export function getSortInstant(task: TaskStore, kind: TaskSortKind): string | undefined {
  const reg = registeredTaskData(task);
  if (reg) {
    if (kind === 'created') return reg.createdAt;
    return reg.lastInteractedAt ?? reg.updatedAt;
  }
  const u = unregisteredTaskData(task);
  if (u) {
    if (kind === 'created') return u.createdAt;
    return u.lastInteractedAt;
  }
  return undefined;
}

function isVisibleRegularTask(task: TaskStore): boolean {
  return (
    task.data.type !== 'automation-run' &&
    (task.state === 'unregistered' || !('archivedAt' in task.data && task.data.archivedAt))
  );
}

export type SidebarRow =
  | { kind: 'project'; projectId: string; nested: boolean }
  | { kind: 'task'; projectId: string; taskId: string; nested: boolean }
  | { kind: 'folder'; folderId: string }
  | { kind: 'archived-header'; count: number }
  | { kind: 'archived-project'; projectId: string };

export type SidebarProjectPlacement = {
  id: string;
  folderId: string | null;
  archived: boolean;
};

export type ProjectDropTarget =
  | { kind: 'project'; projectId: string; before: boolean }
  | { kind: 'folder'; folderId: string };

/** Reorders `projectOrder` and reports the folder the dropped project should join. */
export function planProjectDrop(
  order: readonly string[],
  projects: readonly SidebarProjectPlacement[],
  projectId: string,
  target: ProjectDropTarget
): { order: string[]; folderId: string | null } | null {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const current = byId.get(projectId);
  if (!current || current.archived) return null;

  let folderId: string | null;
  let anchorId: string | null;
  let before: boolean;
  if (target.kind === 'folder') {
    folderId = target.folderId;
    const members = bandIds(order, projects, folderId, projectId);
    if (members.length === 0) {
      if (current.folderId === folderId) return null;
      anchorId = null;
      before = false;
    } else {
      anchorId = members[0] ?? null;
      before = true;
    }
  } else {
    if (target.projectId === projectId) return null;
    const anchor = byId.get(target.projectId);
    if (!anchor || anchor.archived) return null;
    folderId = anchor.folderId;
    anchorId = target.projectId;
    before = target.before;
  }

  const nextOrder = moveId(order, projectId, anchorId, before);
  if (sameIds(nextOrder, order) && folderId === current.folderId) return null;
  return { order: nextOrder, folderId };
}

export function moveId(
  order: readonly string[],
  id: string,
  anchorId: string | null,
  before: boolean
): string[] {
  const without = order.filter((entry) => entry !== id);
  if (!anchorId) {
    without.push(id);
    return without;
  }
  const index = without.indexOf(anchorId);
  if (index === -1) {
    without.push(id);
    return without;
  }
  without.splice(before ? index : index + 1, 0, id);
  return without;
}

function bandIds(
  order: readonly string[],
  projects: readonly SidebarProjectPlacement[],
  folderId: string | null,
  exclude: string
): string[] {
  return projects
    .filter(
      (project) => project.id !== exclude && !project.archived && project.folderId === folderId
    )
    .sort((a, b) => compareOrder(order, a.id, b.id))
    .map((project) => project.id);
}

function compareOrder(order: readonly string[], a: string, b: string): number {
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return -1;
  if (bi === -1) return 1;
  return ai - bi;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function projectPlacement(project: ProjectStore): SidebarProjectPlacement {
  return {
    id: project.id,
    folderId: project.data?.folderId ?? null,
    archived: Boolean(project.data?.archivedAt),
  };
}

export class SidebarStore {
  private _handle: MementoHandle<WorkbenchSidebarState> | undefined;
  private _fallbackState: WorkbenchSidebarState = workbenchSidebarMemento.default;
  private readonly _revealedProjectIds = observable.set<string>();

  constructor(private readonly projectManager: ProjectManagerStore) {
    // `_handle` must stay observable: computeds reading `state` before the
    // memento handle is attached would otherwise capture zero dependencies
    // and freeze at the fallback value forever.
    makeAutoObservable<
      SidebarStore,
      '_fallbackState' | '_handle' | '_revealedProjectIds' | 'projectManager'
    >(this, {
      _fallbackState: false,
      _handle: observable.ref,
      _revealedProjectIds: false,
      projectManager: false,
      expandedProjectIds: computed.struct,
      sidebarRows: computed,
      pinnedSidebarEntries: computed,
    });
  }

  get projectOrder(): string[] {
    return this.state.projectOrder;
  }

  get folderOrder(): string[] {
    return this.state.folderOrder;
  }

  get archivedExpanded(): boolean {
    return this.state.archivedExpanded;
  }

  get taskOrderByProject(): Record<string, string[]> {
    return this.state.taskOrderByProject;
  }

  get expandedProjectIds(): ReadonlySet<string> {
    return new Set([...this.state.expandedProjectIds, ...this._revealedProjectIds]);
  }

  get taskSortBy(): SidebarTaskSortBy {
    return this.state.taskSortBy;
  }

  attachMemento(handle: MementoHandle<WorkbenchSidebarState>): void {
    if (this._handle) throw new Error('Sidebar memento is already attached');
    this._handle = handle;
  }

  get orderedProjects(): ProjectStore[] {
    const all = Array.from(this.projectManager.projects.values());

    return [...all].sort((a, b) => {
      const ai = this.projectOrder.indexOf(a.id);
      const bi = this.projectOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return this.compareSidebarProjects(a, b);
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
  }

  get sidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [];
    const active = this.orderedProjects.filter((project) => !project.data?.archivedAt);
    const archived = this.orderedProjects.filter((project) => Boolean(project.data?.archivedAt));

    for (const project of active) {
      if (project.data?.folderId) continue;
      this.appendProjectRows(rows, project, false);
    }

    for (const folder of this.orderedFolders()) {
      const members = active.filter((project) => project.data?.folderId === folder.id);
      if (members.length === 0) continue;
      rows.push({ kind: 'folder', folderId: folder.id });
      for (const project of members) this.appendProjectRows(rows, project, true);
    }

    if (archived.length > 0) {
      rows.push({ kind: 'archived-header', count: archived.length });
      if (this.archivedExpanded) {
        for (const project of archived) {
          rows.push({ kind: 'archived-project', projectId: project.id });
        }
      }
    }
    return rows;
  }

  /** Visible unpinned tasks in the same order they are rendered in the project tree. */
  get visibleTaskEntries(): { projectId: string; taskId: string }[] {
    return this.sidebarRows
      .filter((row): row is Extract<SidebarRow, { kind: 'task' }> => row.kind === 'task')
      .map(({ projectId, taskId }) => ({ projectId, taskId }));
  }

  /** Flat list of pinned tasks from available Project contexts, in project-tree sort order. */
  get pinnedSidebarEntries(): { projectId: string; taskId: string }[] {
    const pairs: { projectId: string; task: TaskStore }[] = [];
    for (const project of this.projectManager.projects.values()) {
      if (project.data?.archivedAt) continue;
      const context = asAvailableProject(project);
      if (!context) continue;
      const projectId = project.id;
      for (const task of context.get(taskManagerStoreToken).tasks.values()) {
        if (!isVisibleRegularTask(task) || !task.data.isPinned) continue;
        pairs.push({ projectId, task });
      }
    }
    pairs.sort((a, b) => this.compareSidebarTasks(a.task, b.task));
    return pairs.map(({ projectId, task }) => ({ projectId, taskId: task.data.id }));
  }

  /**
   * Visible unpinned task IDs for a project in sidebar order. Archived tasks are
   * and automation tasks are excluded. Independent of expand state so Next/Previous
   * Task navigation works even when the project is collapsed.
   */
  visibleTaskIdsForProject(projectId: string): string[] {
    const project = this.projectManager.projects.get(projectId);
    if (!project) return [];
    const context = asAvailableProject(project);
    if (!context) return [];
    const tasks = Array.from(context.get(taskManagerStoreToken).tasks.values()).filter(
      (task) => isVisibleRegularTask(task) && !task.data.isPinned
    );
    const manualOrder = this.taskOrderByProject[projectId];
    const ordered = manualOrder?.length
      ? this.mergeTaskOrder(projectId, tasks)
      : this.sortTasksForSidebar(tasks);
    return ordered.map((t) => t.data.id);
  }

  get isEmpty(): boolean {
    return this.projectManager.projects.size === 0;
  }

  /** Called on first load when no snapshot exists — expand all known projects. */
  expandAllProjects(): void {
    this.updateState((current) => ({
      ...current,
      expandedProjectIds: this.orderedProjects.map((project) => project.id),
    }));
  }

  toggleProjectExpanded(projectId: string): void {
    const isPersisted = this.state.expandedProjectIds.includes(projectId);
    const isRevealed = this._revealedProjectIds.has(projectId);
    if (isPersisted || isRevealed) {
      this._revealedProjectIds.delete(projectId);
      if (isPersisted) {
        this.updateExpandedProjects((ids) => ids.filter((id) => id !== projectId));
      }
      return;
    }
    this.updateExpandedProjects((ids) => [...ids, projectId]);
  }

  revealProject(projectId: string): void {
    if (!this.expandedProjectIds.has(projectId)) {
      this._revealedProjectIds.add(projectId);
    }
  }

  setTaskSortBy(sortBy: SidebarTaskSortBy): void {
    this.updateState((current) => ({ ...current, taskSortBy: sortBy }));
  }

  /** Set the sort key and clear all manual task orders so the list fully re-sorts. */
  applySort(sortBy: SidebarTaskSortBy): void {
    this.updateState((current) => ({
      ...current,
      taskSortBy: sortBy,
      taskOrderByProject: {},
    }));
  }

  setProjectOrder(ids: string[]): void {
    this.updateState((current) => ({ ...current, projectOrder: ids }));
  }

  setFolderOrder(ids: string[]): void {
    this.updateState((current) => ({ ...current, folderOrder: ids }));
  }

  toggleArchivedExpanded(): void {
    this.updateState((current) => ({ ...current, archivedExpanded: !current.archivedExpanded }));
  }

  /**
   * Moves a project within `projectOrder` and, when the destination band differs,
   * into that folder. The folder write is reverted when the server rejects it.
   */
  applyProjectDrop(projectId: string, target: ProjectDropTarget): void {
    const projects = this.orderedProjects.map(projectPlacement);
    const plan = planProjectDrop(this.projectOrder, projects, projectId, target);
    if (!plan) return;
    const previousOrder = [...this.projectOrder];
    const currentFolder = projects.find((project) => project.id === projectId)?.folderId ?? null;
    this.setProjectOrder(plan.order);
    if (plan.folderId === currentFolder) return;
    void this.projectManager.moveProjectToFolder(projectId, plan.folderId).catch(() => {
      this.setProjectOrder(previousOrder);
    });
  }

  applyFolderDrop(folderId: string, anchorId: string, before: boolean): void {
    if (folderId === anchorId) return;
    const base =
      this.folderOrder.length > 0
        ? this.folderOrder
        : this.orderedFolders().map((folder) => folder.id);
    this.setFolderOrder(moveId(base, folderId, anchorId, before));
  }

  mergeTaskOrder(projectId: string, tasks: TaskStore[]): TaskStore[] {
    const stored = this.taskOrderByProject[projectId] ?? [];
    const byId = new Map(tasks.map((t) => [t.data.id, t] as const));
    const seen = new Set<string>();
    const result: TaskStore[] = [];
    for (const id of stored) {
      const t = byId.get(id);
      if (t) {
        result.push(t);
        seen.add(id);
      }
    }
    // New tasks (not in the manual order) are sorted by date and prepended so
    // they always appear at the top rather than buried after manually-ordered tasks.
    const newTasks = tasks
      .filter((t) => !seen.has(t.data.id))
      .sort((a, b) => this.compareSidebarTasks(a, b));
    return [...newTasks, ...result];
  }

  setTaskOrder(projectId: string, orderedIds: string[]): void {
    this.updateState((current) => ({
      ...current,
      taskOrderByProject: { ...current.taskOrderByProject, [projectId]: orderedIds },
    }));
  }

  private orderedFolders(): { id: string; name: string }[] {
    const folders = this.projectManager.folders ? [...this.projectManager.folders] : [];
    const order = this.folderOrder;
    return folders.sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  private appendProjectRows(rows: SidebarRow[], project: ProjectStore, nested: boolean): void {
    const projectId = project.id;
    rows.push({ kind: 'project', projectId, nested });
    const context = asAvailableProject(project);
    if (!this.expandedProjectIds.has(projectId) || !context) return;
    const tasks = Array.from(context.get(taskManagerStoreToken).tasks.values()).filter(
      isVisibleRegularTask
    );
    const manualOrder = this.taskOrderByProject[projectId];
    const ordered = manualOrder?.length
      ? this.mergeTaskOrder(projectId, tasks)
      : this.sortTasksForSidebar(tasks);
    for (const task of ordered) {
      if (task.data.isPinned) continue;
      rows.push({ kind: 'task', projectId, taskId: task.data.id, nested });
    }
  }

  private get state(): WorkbenchSidebarState {
    return this._handle?.value ?? this._fallbackState;
  }

  private updateState(update: (current: WorkbenchSidebarState) => WorkbenchSidebarState): void {
    if (this._handle) {
      this._handle.update(update);
    } else {
      this._fallbackState = update(this._fallbackState);
    }
  }

  private updateExpandedProjects(update: (current: string[]) => string[]): void {
    this.updateState((current) => ({
      ...current,
      expandedProjectIds: update(current.expandedProjectIds),
    }));
  }

  private compareSidebarTasks(a: TaskStore, b: TaskStore): number {
    const kind = sortKindFor(this.taskSortBy);
    const ia = getSortInstant(a, kind) ?? '';
    const ib = getSortInstant(b, kind) ?? '';
    const d = ib.localeCompare(ia);
    if (d !== 0) return d;
    return a.data.id.localeCompare(b.data.id);
  }

  private compareSidebarProjects(a: ProjectStore, b: ProjectStore): number {
    const d = b.createdAt.localeCompare(a.createdAt);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  }

  private sortTasksForSidebar(tasks: TaskStore[]): TaskStore[] {
    return [...tasks].sort((a, b) => this.compareSidebarTasks(a, b));
  }
}
