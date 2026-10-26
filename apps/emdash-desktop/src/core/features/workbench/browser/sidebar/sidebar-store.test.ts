import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { taskManagerStoreToken } from '@core/features/tasks/contributions/browser/project-store-tokens';
import {
  workbenchSidebarSchema,
  type WorkbenchSidebarState,
} from '@core/features/workbench/contributions/mementos';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { planProjectDrop, SidebarStore } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@core/features/conversations/browser/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@core/features/conversations/browser/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

function projectManager(projects: { id: string; createdAt: string }[]): SidebarProjectManager {
  return {
    projects: new Map(projects.map((p) => [p.id, { ...p, context: null }])),
  } as unknown as SidebarProjectManager;
}

function task(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: {
      id,
      type: 'coding-agent',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function projectManagerWithTasks(
  projects: { id: string; createdAt: string; taskIds: string[] }[]
): SidebarProjectManager {
  return {
    projects: new Map(
      projects.map((project) => {
        const taskManager = {
          tasks: new Map(
            project.taskIds.map((taskId, index) => [
              taskId,
              task(taskId, `2026-01-01T00:00:0${index}.000Z`),
            ])
          ),
        };
        return [
          project.id,
          {
            id: project.id,
            createdAt: project.createdAt,
            context: {
              kind: 'available',
              context: {
                get: (token: unknown) =>
                  token === taskManagerStoreToken ? taskManager : undefined,
              },
            },
          },
        ];
      })
    ),
  } as unknown as SidebarProjectManager;
}

function mementoHandle(
  initial: Omit<WorkbenchSidebarState, 'version' | 'folderOrder' | 'archivedExpanded'> &
    Partial<Pick<WorkbenchSidebarState, 'folderOrder' | 'archivedExpanded'>>
): MementoHandle<WorkbenchSidebarState> {
  let value: WorkbenchSidebarState = {
    version: '2',
    folderOrder: [],
    archivedExpanded: false,
    ...initial,
  };
  return {
    get value() {
      return value;
    },
    ready: Promise.resolve(),
    isPending: false,
    hasStoredValue: true,
    read: () => value,
    update: (next) => {
      value = typeof next === 'function' ? next(value) : next;
    },
    reset: async () => {},
    flush: async () => {},
    autoPersist: () =>
      (() => {}) as ReturnType<MementoHandle<WorkbenchSidebarState>['autoPersist']>,
    dispose: async () => {},
  };
}

describe('workbench sidebar memento', () => {
  it('upgrades a saved v1 list with an empty folder order', () => {
    expect(
      workbenchSidebarSchema.safeParse({
        version: '1',
        expandedProjectIds: ['project-1'],
        projectOrder: ['project-1'],
        taskOrderByProject: {},
        taskSortBy: 'created-at',
      })
    ).toEqual({
      status: 'ok',
      data: {
        version: '2',
        expandedProjectIds: ['project-1'],
        projectOrder: ['project-1'],
        folderOrder: [],
        archivedExpanded: false,
        taskOrderByProject: {},
        taskSortBy: 'created-at',
      },
    });
  });
});

describe('SidebarStore project ordering', () => {
  it('keeps a restored collapsed project collapsed during initial task hydration', () => {
    const tasks = observable.map<string, ReturnType<typeof task>>();
    const project = observable({
      id: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      context: null as null | {
        kind: 'available';
        context: { get: () => { tasks: typeof tasks } };
      },
    });
    const manager = {
      projects: observable.map([['project-1', project]]),
    } as unknown as SidebarProjectManager;
    const handle = mementoHandle({
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
    });
    const store = new SidebarStore(manager);
    store.attachMemento(handle);

    runInAction(() => {
      project.context = {
        kind: 'available',
        context: { get: () => ({ tasks }) },
      };
    });
    runInAction(() => {
      tasks.set('task-1', task('task-1', '2026-01-01T00:00:00.000Z'));
    });

    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
  });

  it('reads and writes through an attached memento', () => {
    const store = new SidebarStore(projectManager([]));
    const handle = mementoHandle({
      expandedProjectIds: ['project-1'],
      projectOrder: ['project-1'],
      taskOrderByProject: {},
      taskSortBy: 'updated-at',
    });

    store.attachMemento(handle);
    expect([...store.expandedProjectIds]).toEqual(['project-1']);
    expect(store.taskSortBy).toBe('updated-at');

    store.setTaskSortBy('created-at');
    expect(handle.value.taskSortBy).toBe('created-at');
  });

  it('reveals a project without changing its persisted expansion preference', () => {
    const store = new SidebarStore(projectManager([{ id: 'project-1', createdAt: '2026-01-01' }]));
    const handle = mementoHandle({
      expandedProjectIds: [],
      projectOrder: [],
      taskOrderByProject: {},
      taskSortBy: 'created-at',
    });
    store.attachMemento(handle);

    store.revealProject('project-1');
    expect([...store.expandedProjectIds]).toEqual(['project-1']);
    expect(handle.value.expandedProjectIds).toEqual([]);

    store.toggleProjectExpanded('project-1');
    expect([...store.expandedProjectIds]).toEqual([]);
    expect(handle.value.expandedProjectIds).toEqual([]);
  });

  it('sorts projects newest first by default', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setProjectOrder(['manual', 'old']);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });

  it('returns visible task entries in rendered project-tree order', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          taskIds: ['task-1a', 'task-1b'],
        },
        {
          id: 'project-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          taskIds: ['task-2a'],
        },
      ])
    );

    store.setProjectOrder(['project-1', 'project-2']);
    store.toggleProjectExpanded('project-1');
    store.toggleProjectExpanded('project-2');
    store.setTaskOrder('project-1', ['task-1a', 'task-1b']);

    expect(store.visibleTaskEntries).toEqual([
      { projectId: 'project-1', taskId: 'task-1a' },
      { projectId: 'project-1', taskId: 'task-1b' },
      { projectId: 'project-2', taskId: 'task-2a' },
    ]);
  });

  it('excludes pinned automation runs from every sidebar selector', () => {
    const manager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        taskIds: ['regular-task', 'automation-task'],
      },
    ]);
    const project = manager.projects.get('project-1')!;
    const context = project.context?.kind === 'available' ? project.context.context : undefined;
    const tasks = context!.get(taskManagerStoreToken).tasks;
    tasks.get('regular-task')!.data.isPinned = true;
    tasks.get('automation-task')!.data.isPinned = true;
    tasks.get('automation-task')!.data.type = 'automation-run';

    const store = new SidebarStore(manager);
    store.toggleProjectExpanded('project-1');

    expect(store.pinnedSidebarEntries).toEqual([
      { projectId: 'project-1', taskId: 'regular-task' },
    ]);
    expect(store.visibleTaskIdsForProject('project-1')).toEqual([]);
    expect(store.sidebarRows).toEqual([{ kind: 'project', projectId: 'project-1', nested: false }]);
  });
});

describe('sidebar project folders and archive', () => {
  function placed(id: string, folderId: string | null, archivedAt: string | null = null) {
    return {
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      data: { folderId, archivedAt },
      context: null,
    };
  }

  function groupedManager() {
    return {
      projects: new Map([
        ['emdash', placed('emdash', null)],
        ['notes', placed('notes', null)],
        ['old-client', placed('old-client', 'client')],
        ['alpha', placed('alpha', 'client')],
        ['scratch', placed('scratch', 'personal', '2026-02-01T00:00:00.000Z')],
      ]),
      folders: [
        { id: 'personal', name: 'Personal' },
        { id: 'client', name: 'Client' },
      ],
    } as unknown as SidebarProjectManager;
  }

  it('draws ungrouped projects, folders with active members, and a collapsed archive', () => {
    const store = new SidebarStore(groupedManager());
    store.attachMemento(
      mementoHandle({
        expandedProjectIds: [],
        projectOrder: ['emdash', 'notes', 'old-client', 'alpha', 'scratch'],
        folderOrder: ['client', 'personal'],
        taskOrderByProject: {},
        taskSortBy: 'created-at',
      })
    );

    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'emdash', nested: false },
      { kind: 'project', projectId: 'notes', nested: false },
      { kind: 'folder', folderId: 'client' },
      { kind: 'project', projectId: 'old-client', nested: true },
      { kind: 'project', projectId: 'alpha', nested: true },
      { kind: 'archived-header', count: 1 },
    ]);
  });

  it('hides a folder whose only project is archived and shows that project when restored', () => {
    const scratch = observable({
      id: 'scratch',
      createdAt: '2026-01-01T00:00:00.000Z',
      data: {
        folderId: 'personal' as string | null,
        archivedAt: '2026-02-01T00:00:00.000Z' as string | null,
      },
      context: null,
    });
    const emdash = placed('emdash', null);
    const manager = {
      projects: observable.map([
        ['emdash', emdash],
        ['scratch', scratch],
      ]),
      folders: [{ id: 'personal', name: 'Personal' }],
    } as unknown as SidebarProjectManager;
    const store = new SidebarStore(manager);
    store.attachMemento(
      mementoHandle({
        expandedProjectIds: [],
        projectOrder: ['scratch', 'emdash'],
        folderOrder: ['personal'],
        taskOrderByProject: {},
        taskSortBy: 'created-at',
        archivedExpanded: true,
      })
    );

    expect(store.sidebarRows.some((row) => row.kind === 'folder')).toBe(false);
    expect(store.sidebarRows).toContainEqual({ kind: 'archived-project', projectId: 'scratch' });

    runInAction(() => {
      scratch.data = { folderId: 'personal', archivedAt: null };
    });
    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'emdash', nested: false },
      { kind: 'folder', folderId: 'personal' },
      { kind: 'project', projectId: 'scratch', nested: true },
    ]);
  });

  it('drops a pinned task of an archived project from the pin strip', () => {
    const tasks = new Map([
      [
        'pinned',
        {
          state: 'provisioned',
          data: {
            id: 'pinned',
            type: 'coding-agent',
            isPinned: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    ]);
    const project = observable({
      id: 'old',
      createdAt: '2026-01-01T00:00:00.000Z',
      data: {
        folderId: null as string | null,
        archivedAt: '2026-02-01T00:00:00.000Z' as string | null,
      },
      context: {
        kind: 'available' as const,
        context: {
          get: (token: unknown) => (token === taskManagerStoreToken ? { tasks } : undefined),
        },
      },
    });
    const manager = {
      projects: observable.map([['old', project]]),
      folders: [],
    } as unknown as SidebarProjectManager;
    const store = new SidebarStore(manager);
    expect(store.pinnedSidebarEntries).toEqual([]);

    runInAction(() => {
      project.data = { folderId: null, archivedAt: null };
    });
    expect(store.pinnedSidebarEntries).toEqual([{ projectId: 'old', taskId: 'pinned' }]);
  });
});

describe('planProjectDrop', () => {
  const projects = [
    { id: 'emdash', folderId: null, archived: false },
    { id: 'notes', folderId: null, archived: false },
    { id: 'old-client', folderId: 'client', archived: false },
    { id: 'alpha', folderId: 'client', archived: false },
    { id: 'scratch', folderId: 'personal', archived: true },
  ];
  const order = ['emdash', 'notes', 'old-client', 'alpha', 'scratch'];

  it('moves a project into another folder ahead of that folder’s first project', () => {
    expect(
      planProjectDrop(order, projects, 'notes', { kind: 'folder', folderId: 'client' })
    ).toEqual({
      order: ['emdash', 'notes', 'old-client', 'alpha', 'scratch'],
      folderId: 'client',
    });
  });

  it('clears the folder when a project is dropped into the ungrouped band', () => {
    expect(
      planProjectDrop(order, projects, 'alpha', {
        kind: 'project',
        projectId: 'emdash',
        before: true,
      })
    ).toEqual({
      order: ['alpha', 'emdash', 'notes', 'old-client', 'scratch'],
      folderId: null,
    });
  });

  it('reorders inside the same band', () => {
    expect(
      planProjectDrop(order, projects, 'alpha', {
        kind: 'project',
        projectId: 'old-client',
        before: true,
      })
    ).toEqual({
      order: ['emdash', 'notes', 'alpha', 'old-client', 'scratch'],
      folderId: 'client',
    });
  });

  it('does not move onto an archived project', () => {
    expect(
      planProjectDrop(order, projects, 'notes', {
        kind: 'project',
        projectId: 'scratch',
        before: true,
      })
    ).toBeNull();
  });
});
