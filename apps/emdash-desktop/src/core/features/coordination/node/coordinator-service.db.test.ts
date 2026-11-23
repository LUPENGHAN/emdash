import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentCaller } from '@core/features/agent-control/api';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import type { Coordinator } from '../api/types';
import { CoordinatorService } from './coordinator-service';
import { createSelectionResolver } from './selection-resolver';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture('empty');
});
afterEach(() => {
  fixture.close();
});

it('restores coordinator identity, defaults, result snapshots and acknowledgment from SQLite', async () => {
  const deliver = vi.fn(async () => {});
  const service = (): CoordinatorService =>
    new CoordinatorService({
      store: new AppDbKeyValueStore<Record<string, Coordinator>>(fixture.db, 'coordinators'),
      getTask: async () => null,
      getConversation: async (id) =>
        id === 'replacement-main' || id === record.conversationId
          ? {
              taskId: record.taskId,
              projectId: record.projectId,
              selection: { agent: 'codex' },
            }
          : null,
      resources: () => {
        throw new Error('No runtime should be allocated');
      },
      defaultAgent: async () => 'claude',
      resolveSelection: createSelectionResolver({
        defaultAgent: async () => 'claude',
        getAgentSettings: async () => undefined,
        getProviders: async () => [],
        getModels: async () => [],
      }),
      assertProjectAvailable: async () => {},
      setTaskStatus: async () => {},
      emit: () => {},
      deliver,
    });
  const first = service();
  const record = await first.ensureProject('project');
  const main: AgentCaller = {
    conversationId: record.conversationId,
    taskId: record.taskId,
    projectId: record.projectId,
    providerId: 'claude',
    title: 'Main',
    cwd: null,
  };
  await first.update(record.id, {
    delegationDefaults: { agent: 'codex', effort: 'high' },
    projectAccess: { mode: 'selected', projectIds: ['project', 'other'] },
  });
  await first.registerDelegation(
    main,
    {
      id: 'worker',
      projectId: record.projectId,
      taskConfig: { version: '1', name: 'Code task' },
      workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    },
    ['other']
  );
  await first.markTaskCreated('worker');
  await first.bindConversation(record.id, record.conversationId, true);
  const receipt = await first.submit({ ...main, taskId: 'worker' }, 'worker', 'submission', {
    summary: 'Implemented',
    commits: ['abc'],
    checks: [],
    unresolved: ['Needs review'],
    prUrls: [],
  });
  await first.deliverPending(record.id);
  deliver.mockClear();
  const restarted = service();
  expect((await restarted.getByTask(record.taskId))?.projectAccess).toEqual({
    mode: 'selected',
    projectIds: ['project', 'other'],
  });
  expect(await restarted.mayAccessProject({ ...main, taskId: 'worker' }, 'other', 'delegate')).toBe(
    true
  );
  await restarted.recover();
  expect(deliver).toHaveBeenCalledOnce();
  expect((await restarted.getByTask(main.taskId))?.delegationDefaults).toEqual({
    agent: 'codex',
    effort: 'high',
  });
  expect((await restarted.getByTask(main.taskId))?.tasks.worker.result?.unresolved).toEqual([
    'Needs review',
  ]);
  await restarted.acknowledge(main, [receipt.eventId]);
  deliver.mockClear();
  await service().recover();
  expect(deliver).not.toHaveBeenCalled();
  expect((await service().ensureProject('project')).taskId).toBe(main.taskId);
  await restarted.bindConversation(record.id, 'replacement-main', true);
  const switched = await service().getByTask(record.taskId);
  expect(switched?.conversationId).toBe('replacement-main');
  expect(switched?.tasks.worker.result?.summary).toBe('Implemented');
  expect(switched?.events[0].state).toBe('acknowledged');
});

it('rolls back both owners on a SQLite write failure and transfers results after retry', async () => {
  const store = new AppDbKeyValueStore<Record<string, Coordinator>>(fixture.db, 'coordinators');
  const make = () =>
    new CoordinatorService({
      store,
      resources: () => {
        throw new Error('No runtime should be allocated');
      },
      getTask: async (id) =>
        id === 'worker' ? { id, projectId: 'source', name: 'Worker', type: 'task' } : null,
      getConversation: async () => null,
      defaultAgent: async () => 'claude',
      resolveSelection: createSelectionResolver({
        defaultAgent: async () => 'claude',
        getAgentSettings: async () => undefined,
        getProviders: async () => [],
        getModels: async () => [],
      }),
      assertProjectAvailable: async () => {},
      setTaskStatus: async () => {},
      emit: () => {},
      deliver: async () => {
        throw new Error('Receiver offline');
      },
    });
  const service = make();
  const source = await service.ensureProject('source');
  const target = await service.ensureProject('target');
  const caller: AgentCaller = {
    taskId: source.taskId,
    conversationId: source.conversationId,
    projectId: source.projectId,
    providerId: 'claude',
    title: 'Main',
    cwd: null,
  };
  await service.registerDelegation(caller, {
    id: 'worker',
    projectId: 'source',
    taskConfig: { version: '1', name: 'Worker' },
    workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
  });
  await service.markTaskCreated('worker');
  const receipt = await service.submit({ ...caller, taskId: 'worker' }, 'worker', 'result', {
    summary: 'Ready for review',
    commits: ['abc'],
    checks: [],
    unresolved: [],
    prUrls: [],
  });
  await service.deliverPending(source.id);
  fixture.sqlite.exec(
    "CREATE TRIGGER reject_transfer BEFORE UPDATE ON kv WHEN NEW.key = 'coordinators:project:target' BEGIN SELECT RAISE(ABORT, 'transfer write failed'); END"
  );
  await expect(service.takeOverTask(target.id, 'worker', source.id)).rejects.toThrow(
    'transfer write failed'
  );
  expect((await make().getByTask(source.taskId))?.tasks.worker.result?.summary).toBe(
    'Ready for review'
  );
  expect((await make().getByTask(target.taskId))?.tasks.worker).toBeUndefined();
  fixture.sqlite.exec('DROP TRIGGER reject_transfer');
  await service.takeOverTask(target.id, 'worker', source.id);
  await service.deliverPending(target.id);
  const restarted = make();
  expect((await restarted.getTaskCoordination('worker'))?.coordinatorId).toBe(target.id);
  expect((await restarted.getByTask(source.taskId))?.events).toEqual([]);
  expect((await restarted.getByTask(target.taskId))?.events[0].id).toBe(receipt.eventId);
  expect((await restarted.getByTask(target.taskId))?.tasks.worker.resultVersion).toBe(1);
});

it('retains waiting plans, approved prerequisite snapshots and cancellation in SQLite', async () => {
  const make = () =>
    new CoordinatorService({
      store: new AppDbKeyValueStore<Record<string, Coordinator>>(fixture.db, 'coordinators'),
      getTask: async (id) =>
        id === 'parent' ? { id, projectId: 'project', name: 'Parent', type: 'task' } : null,
      getConversation: async () => null,
      resources: () => {
        throw new Error('No runtime should be allocated');
      },
      defaultAgent: async () => 'claude',
      resolveSelection: createSelectionResolver({
        defaultAgent: async () => 'claude',
        getAgentSettings: async () => undefined,
        getProviders: async () => [],
        getModels: async () => [],
      }),
      assertProjectAvailable: async () => {},
      setTaskStatus: async () => {},
      emit: () => {},
      deliver: async () => {},
    });
  const service = make();
  const main = await service.ensureProject('project');
  const caller: AgentCaller = {
    taskId: main.taskId,
    conversationId: main.conversationId,
    projectId: 'project',
    providerId: 'claude',
    title: 'Main',
    cwd: null,
  };
  const plan = (id: string) => ({
    id,
    projectId: 'project',
    taskConfig: { version: '1' as const, name: id },
    workspaceConfig: {
      version: '2' as const,
      git: { kind: 'none' as const },
      workspace: { kind: 'new-worktree' as const },
    },
  });
  await service.registerDelegation(caller, plan('parent'));
  await service.markTaskCreated('parent');
  await service.registerDelegation(caller, plan('child'), [], ['parent']);
  await service.registerDelegation(caller, plan('cancelled'), [], ['parent']);
  await service.cancelPendingTask(main.id, 'cancelled');
  expect(await make().dependencyGate('child')).toContain('Waiting for review');
  await make().submit({ ...caller, taskId: 'parent' }, 'parent', 'result', {
    summary: 'Checked',
    commits: ['abc'],
    checks: [],
    unresolved: [],
    prUrls: [],
  });
  await make().review(main.id, 'parent', true, 'Verified', 1);
  expect(await make().dependencyGate('child')).toBeNull();
  expect((await make().getTaskCoordination('child'))?.assignment?.dependencyResults).toEqual([
    { taskId: 'parent', projectId: 'project', version: 1, commits: ['abc'] },
  ]);
  expect(await make().dependencyGate('cancelled')).toContain('cancelled');
});

it('restores frozen task document content from SQLite without accessing the source host', async () => {
  const store = new AppDbKeyValueStore<Record<string, Coordinator>>(fixture.db, 'coordinators');
  const read = vi.fn(async (record: Coordinator, path: string) => ({
    coordinatorId: record.id,
    path,
    revision: 'disk:selected',
    content: 'Saved context',
    workspaceId: 'documents',
  }));
  const make = (withDocuments: boolean) =>
    new CoordinatorService({
      store,
      ...(withDocuments && { documents: { read, describe: vi.fn(), create: vi.fn() } }),
      getTask: async () => null,
      getConversation: async () => null,
      resources: () => {
        throw new Error('No runtime should be allocated');
      },
      defaultAgent: async () => 'claude',
      resolveSelection: async () => ({
        values: { agent: 'claude' },
        sources: {},
        effortOptions: {},
        errors: [],
      }),
      assertProjectAvailable: async () => {},
      setTaskStatus: async () => {},
      emit: () => {},
      deliver: async () => {},
    });
  const service = make(true);
  const main = await service.ensureProject('project');
  const caller: AgentCaller = {
    taskId: main.taskId,
    conversationId: main.conversationId,
    projectId: 'project',
    providerId: 'claude',
    title: 'Main',
    cwd: null,
  };
  await service.registerDelegation(
    caller,
    {
      id: 'worker',
      projectId: 'project',
      taskConfig: { version: '1', name: 'Worker' },
      workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    },
    [],
    [],
    [{ path: 'plan.md' }]
  );
  const restored = make(false);
  const snapshot = (await restored.getTaskCoordination('worker'))?.assignment?.documents?.[0];
  expect(snapshot).toMatchObject({
    coordinatorId: main.id,
    path: 'plan.md',
    revision: 'disk:selected',
    content: 'Saved context',
  });
  expect(await restored.instructionsForTask('worker')).toContain('Saved context');
  await expect(
    restored.readDocument(main.id, 'plan.md', 'disk:selected', {
      ...caller,
      taskId: 'worker',
      conversationId: 'worker-conversation',
    })
  ).resolves.toEqual(snapshot);
  expect(read).toHaveBeenCalledOnce();
});

it('restores a document push target and its removal from SQLite without starting an agent', async () => {
  const store = new AppDbKeyValueStore<Record<string, Coordinator>>(fixture.db, 'coordinators');
  const target = {
    remote: 'personal',
    destination: '/personal-fork.git',
    fingerprint: 'a'.repeat(64),
  };
  const make = () =>
    new CoordinatorService({
      store,
      getTask: async () => null,
      getConversation: async () => null,
      resources: () => {
        throw new Error('No runtime should be allocated');
      },
      defaultAgent: async () => 'claude',
      resolveSelection: async () => ({
        values: { agent: 'claude' },
        sources: {},
        effortOptions: {},
        errors: [],
      }),
      assertProjectAvailable: async () => {},
      setTaskStatus: async () => {},
      emit: () => {},
      deliver: async () => {},
      documents: {
        read: vi.fn(),
        create: vi.fn(),
        describe: vi.fn(),
        pushTarget: async () => target,
      },
    });
  const main = await make().ensureProject('project');
  await make().configureDocumentPush(main.id, target.remote, target.fingerprint);
  expect((await make().getByTask(main.taskId))?.documentPushTarget).toEqual(target);
  await make().configureDocumentPush(main.id, null);
  expect((await make().getByTask(main.taskId))?.documentPushTarget).toBeUndefined();
});
