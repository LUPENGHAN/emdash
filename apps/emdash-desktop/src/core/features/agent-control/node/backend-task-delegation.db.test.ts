import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { createScope } from '@emdash/shared/concurrency';
import { cell } from '@emdash/wire/state';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectAttachmentState } from '@core/features/projects/api/attachments';
import type { ProjectBaselineSelection } from '@core/features/projects/api/baseline-sync';
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

async function setup(options: { directory?: boolean } = {}) {
  const [projectRow] = await fixture.db.select().from(projects).limit(1);
  const state = cell<ProjectAttachmentState>({ kind: 'attached', establishedHostGeneration: 1 });
  const provider = {
    projectId: projectRow.id,
    project: projectRow,
    host: LOCAL_HOST_REF,
    hasRepository: !options.directory,
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

it('freezes the approved commit and evidence across dependency waiting and service recovery', async () => {
  const t = await setup();
  const oid = 'a'.repeat(40);
  const selection: ProjectBaselineSelection = {
    oid,
    checkedAt: 100,
    offline: false,
    revision: 0,
    remoteFingerprint: null,
    verification: 'not-configured',
    verifiedAt: null,
    target: {
      projectId: t.caller.projectId,
      repositoryKey: 'repo',
      workspaceId: 'root',
      host: LOCAL_HOST_REF,
      checkout: '/repo',
      baselineRef: 'refs/heads/develop' as ProjectBaselineSelection['target']['baselineRef'],
      remote: null,
      upstreamRef: null,
    },
  };
  const prepareBaseline = vi.fn(async () => structuredClone(selection));
  let waiting = true;
  const deps = {
    ...t.dependencies,
    prepareBaseline,
    getBlocker: async () => (waiting ? 'Dependency pending' : null),
  };
  const request = {
    kind: 'create_task' as const,
    requestId: 'frozen-base',
    name: 'Frozen',
    prompt: 'Implement it',
  };
  const first = createBackendTaskDelegation(deps);
  const dispatched = JSON.parse((await first.dispatch(t.caller, request)).text);
  expect(t.createTask).not.toHaveBeenCalled();
  expect((await first.status(dispatched.task_id))?.baselineSelection?.oid).toBe(oid);
  prepareBaseline.mockResolvedValue({ ...selection, oid: 'b'.repeat(40) });
  waiting = false;
  const restored = createBackendTaskDelegation(deps);
  await restored.retry(t.caller, dispatched.task_id);
  expect(t.createTask).toHaveBeenCalledOnce();
  expect(vi.mocked(t.createTask).mock.calls[0]?.[0].workspaceConfig.git).toMatchObject({
    kind: 'create-branch',
    fromBranch: { type: 'local', branch: oid },
  });
  expect((await restored.status(dispatched.task_id))?.baselineSelection).toEqual(selection);
  expect(prepareBaseline).toHaveBeenCalledOnce();
});

it('does not create resources or start an agent when baseline checks reject delegation', async () => {
  const t = await setup();
  const prepareBaseline = vi.fn(async () => {
    throw new Error('Baseline verification failed');
  });
  const service = createBackendTaskDelegation({ ...t.dependencies, prepareBaseline });
  await expect(
    service.dispatch(t.caller, {
      kind: 'create_task',
      requestId: 'blocked-base',
      name: 'Blocked',
      prompt: 'Fix it',
    })
  ).rejects.toThrow('verification failed');
  expect(t.createTask).not.toHaveBeenCalled();
  expect(t.provisionWorkspace).not.toHaveBeenCalled();
  expect(t.dependencies.startConversation).not.toHaveBeenCalled();
});

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

it('prepares document-only storage without consulting an unavailable Agent or model configuration', async () => {
  const test = await setup();
  const getAgentSettings = vi.fn(async () => {
    throw new Error('Agent configuration unavailable');
  });
  const getAcpOptions = vi.fn(async () => {
    throw new Error('ACP unavailable');
  });
  const service = createBackendTaskDelegation({
    ...test.dependencies,
    getAgentSettings,
    getAcpOptions,
  });
  const params = await service.resources.prepare(
    { ...test.caller, providerId: 'unavailable-agent' },
    { kind: 'create_task', name: 'Documents' },
    { taskId: 'documents', conversationId: 'unused', role: 'coordination' }
  );
  expect(params.workspaceConfig.git).toEqual({
    kind: 'management',
    branchName: 'emdash/manage/documents',
  });
  expect(params.taskConfig.initialConversation).toBeUndefined();
  expect(getAgentSettings).not.toHaveBeenCalled();
  expect(getAcpOptions).not.toHaveBeenCalled();
  expect(test.dependencies.startConversation).not.toHaveBeenCalled();
});

it('opens a directory main on its registered workspace without Git reads or allowing code delegation', async () => {
  const test = await setup({ directory: true });
  const attached = test.dependencies.projects.requireAttached(test.caller.projectId);
  if (!attached.success) throw new Error('Project unavailable');
  const facts = vi.spyOn(attached.data.repoFacts, 'get');
  const remotes = vi.spyOn(attached.data.git.repository.model, 'state');
  const service = createBackendTaskDelegation(test.dependencies);
  const request = {
    kind: 'create_task' as const,
    name: 'Directory main',
    prompt: 'Coordinate',
    connection: 'official' as const,
    ui: 'chat' as const,
  };
  const params = await service.resources.prepare(test.caller, request, {
    taskId: 'main',
    conversationId: 'main-conversation',
    role: 'coordination',
  });
  expect(params.workspaceConfig).toEqual({
    version: '2',
    git: { kind: 'none' },
    workspace: {
      kind: 'repository-instance',
      workspaceId: attached.data.project.repositoryWorkspaceId,
    },
  });
  expect(params.taskConfig.initialConversation?.provider).toBe('claude');
  expect(facts).not.toHaveBeenCalled();
  expect(remotes).not.toHaveBeenCalled();
  await expect(service.dispatch(test.caller, request)).rejects.toThrow('needs a Git repository');
  expect(test.createTask).not.toHaveBeenCalled();
  expect(test.dependencies.startConversation).not.toHaveBeenCalled();
});
