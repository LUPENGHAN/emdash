import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { createScope } from '@emdash/shared/concurrency';
import { cell } from '@emdash/wire/state';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectAttachmentState } from '@core/features/projects/api/attachments';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { CreateTaskParams, Task } from '@core/primitives/tasks/api';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { createBackendTaskDelegation } from './backend-task-delegation';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let scope: ReturnType<typeof createScope>;
beforeEach(async () => {
  fixture = await openFixture('baseline');
  scope = createScope({ label: 'backend-delegation-test' });
});
afterEach(async () => {
  await scope.dispose();
  fixture.close();
});

async function setup() {
  const [projectRow] = await fixture.db.select().from(projects).limit(1);
  const state = cell<ProjectAttachmentState>({ kind: 'attached', establishedHostGeneration: 1 });
  const provider = {
    projectId: projectRow.id,
    host: LOCAL_HOST_REF,
    hasRepository: true,
    settings: {
      getStoredGitSettings: async () => ({ defaultBranch: { remote: null, branch: 'develop' } }),
      getPlacementContext: async () => ({
        builtInWorktreeRoot: '/tmp/worktrees',
        homeDirectory: '/tmp',
      }),
    },
    repoFacts: {
      get: async () => ({ remotes: [], localBranches: ['develop', 'emdash/manage/docs'] }),
    },
    git: {
      repository: {
        model: { state: () => ({ snapshot: async () => ({ data: { remotes: [] } }) }) },
      },
    },
    repository: {},
  } as unknown as ProjectProvider;
  const track = vi.fn(() => state);
  const manager = {
    track,
    requireAttached: () => ({ success: true as const, data: provider }),
  } as unknown as ProjectAttachmentManager;
  const createTask: TaskService['createTask'] = vi.fn(async (params: CreateTaskParams) => {
    await fixture.db.insert(tasks).values({
      id: params.id,
      projectId: params.projectId,
      name: params.taskConfig.name,
      type: 'task',
      status: 'in_progress',
    });
    return { success: true as const, data: { task: {} as Task } };
  });
  const provisionWorkspace: TaskService['provisionWorkspace'] = vi.fn(async () => ({
    success: true as const,
    data: { path: '/tmp/task', workspaceId: 'workspace' },
  }));
  const dependencies = {
    db: fixture.db,
    scope,
    projects: manager,
    taskService: { createTask, provisionWorkspace },
    getAcpOptions: async () => ({}),
    startConversation: vi.fn(async () => {}),
    getAgentSettings: async () => ({
      modelSource: 'gateway:models',
      sourceModel: 'shared',
      effort: 'high',
    }),
    getBranchDefaults: async () => ({ appendRandomBranchSuffix: true }),
    authorize: async () => {},
  } satisfies Parameters<typeof createBackendTaskDelegation>[0];
  const caller = {
    conversationId: 'main',
    taskId: 'management',
    projectId: projectRow.id,
    providerId: 'claude',
    title: 'Coordinator',
    cwd: '/repo/management-worktree',
  };
  return { dependencies, caller, track, state, createTask, provisionWorkspace };
}

it('uses the project baseline and frozen defaults without any renderer or caller branch lookup', async () => {
  const test = await setup();
  const service = createBackendTaskDelegation(test.dependencies);
  const result = JSON.parse(
    (
      await service.dispatch(test.caller, {
        kind: 'create_task',
        requestId: 'same',
        name: 'Implement',
        prompt: 'Fix it',
      })
    ).text
  );
  const params = vi.mocked(test.createTask).mock.calls[0][0];
  expect(params.workspaceConfig.git).toMatchObject({
    kind: 'create-branch',
    fromBranch: { type: 'local', branch: 'develop' },
  });
  expect(params.taskConfig.initialConversation).toMatchObject({
    effort: 'high',
    modelSource: 'gateway:models',
    sourceModel: 'shared',
  });
  expect(params.taskConfig.initialConversation?.model).toBeUndefined();
  expect(result.status).toBe('agent_started');
  expect(test.track).toHaveBeenCalledOnce();
  const afterRestart = createBackendTaskDelegation(test.dependencies);
  expect(
    JSON.parse(
      (
        await afterRestart.dispatch(test.caller, {
          kind: 'create_task',
          requestId: 'same',
          name: 'Implement',
          prompt: 'Fix it',
        })
      ).text
    ).task_id
  ).toBe(result.task_id);
  expect(test.createTask).toHaveBeenCalledOnce();
});

it('preserves resources after activation failure and reuses a fresh project attachment', async () => {
  const test = await setup();
  const service = createBackendTaskDelegation(test.dependencies);
  vi.mocked(test.provisionWorkspace).mockRejectedValueOnce(new Error('Disconnected'));
  const request = { kind: 'create_task' as const, requestId: 'activation', name: 'Implement' };
  await expect(service.dispatch(test.caller, request)).rejects.toThrow('Disconnected');
  test.state.set({ kind: 'attached', establishedHostGeneration: 2 });
  const result = await service.dispatch(test.caller, request);
  expect(JSON.parse(result.text).status).toBe('workspace_ready');
  expect(test.createTask).toHaveBeenCalledOnce();
  expect(test.provisionWorkspace).toHaveBeenCalledTimes(2);
});

it('refuses an explicit management branch before creating any code task', async () => {
  const test = await setup();
  const service = createBackendTaskDelegation(test.dependencies);
  await expect(
    service.dispatch(test.caller, {
      kind: 'create_task',
      name: 'Wrong base',
      baseBranch: 'emdash/manage/docs',
    })
  ).rejects.toThrow('Management branches');
  expect(test.createTask).not.toHaveBeenCalled();
});

it('applies worker defaults to delegation and keeps them out of the main runtime preparation', async () => {
  const test = await setup();
  const defaults = vi.fn(async () => ({
    providerId: 'codex',
    effort: 'high',
    connection: 'official' as const,
  }));
  const service = createBackendTaskDelegation({
    ...test.dependencies,
    getDelegationDefaults: defaults,
  });
  const action = { kind: 'create_task' as const, name: 'Worker', prompt: 'Implement' };
  const worker = await service.resources.prepare(test.caller, action, {
    taskId: 'worker',
    conversationId: 'worker-conversation',
  });
  expect(worker.taskConfig.initialConversation?.provider).toBe('codex');
  defaults.mockClear();
  const main = await service.resources.prepare(
    test.caller,
    {
      ...action,
      providerId: 'claude',
      connection: 'official',
      effort: 'low',
    },
    { taskId: 'main', conversationId: 'main-conversation', role: 'coordination' }
  );
  expect(defaults).not.toHaveBeenCalled();
  expect(main.workspaceConfig.git).toEqual({
    kind: 'management',
    branchName: 'emdash/manage/main',
  });
  expect(main.taskConfig.initialConversation).toMatchObject({ provider: 'claude', effort: 'low' });
});

it('prepares a management workspace without a code baseline while refusing code delegation', async () => {
  const test = await setup();
  const attached = test.dependencies.projects.requireAttached(test.caller.projectId);
  if (!attached.success) throw new Error('Project unavailable');
  vi.spyOn(attached.data.repoFacts, 'get').mockImplementation(async () => ({
    remotes: [],
    localBranches: [],
  }));
  const service = createBackendTaskDelegation(test.dependencies);
  const request = {
    kind: 'create_task' as const,
    name: 'Main',
    prompt: 'Coordinate',
    providerId: 'claude',
    connection: 'official' as const,
    effort: 'low',
  };
  const main = await service.resources.prepare(test.caller, request, {
    taskId: 'main',
    conversationId: 'main-conversation',
    role: 'coordination',
  });
  expect(main.workspaceConfig.git).toEqual({
    kind: 'management',
    branchName: 'emdash/manage/main',
  });
  expect(main.taskConfig.role).toBe('coordination');
  await expect(
    service.resources.prepare(test.caller, request, {
      taskId: 'code',
      conversationId: 'code-conversation',
    })
  ).rejects.toThrow('code baseline');
  expect(test.createTask).not.toHaveBeenCalled();
});
