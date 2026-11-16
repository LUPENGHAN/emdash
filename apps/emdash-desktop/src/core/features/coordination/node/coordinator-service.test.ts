import { deferred } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { DelegationResources } from '@core/features/agent-control/api/node/delegation-resources';
import type { Coordinator, TaskResult } from '../api/types';
import { CoordinatorService } from './coordinator-service';
import { createSelectionResolver } from './selection-resolver';

function setup() {
  const records = new Map<string, Coordinator>();
  const tasks = new Set<string>();
  const resources: DelegationResources = {
    prepare: vi.fn<DelegationResources['prepare']>(async (_caller, request, ids) => ({
      id: ids.taskId,
      projectId: request.projectId!,
      taskConfig: {
        version: '1',
        name: request.name,
        initialConversation: {
          id: ids.conversationId,
          provider: 'claude',
          type: 'acp',
          initialQueue: [{ text: request.prompt! }],
        },
      },
      workspaceConfig: {
        version: '2',
        git: {
          kind: 'create-branch',
          branchName: 'code',
          fromBranch: { type: 'local', branch: 'main' },
        },
        workspace: { kind: 'new-worktree' },
      },
    })),
    findTask: async (id) => (tasks.has(id) ? 'available' : 'missing'),
    create: vi.fn(async (params) => {
      tasks.add(params.id);
    }),
    activate: vi.fn(async () => ({ path: '/management' })),
    start: vi.fn(async () => {}),
  };
  const deps = {
    store: {
      getOrThrow: async (id: string) =>
        records.has(id) ? structuredClone(records.get(id)!) : null,
      getAll: async () => structuredClone(Object.fromEntries(records)),
      setOrThrow: async (id: string, value: Coordinator) => {
        records.set(id, structuredClone(value));
      },
    },
    resources: () => resources,
    defaultAgent: async () => 'claude',
    resolveSelection: createSelectionResolver({
      defaultAgent: async () => 'claude',
      getAgentSettings: async () => undefined,
      getProviders: async () => [],
      getModels: async () => [],
    }),
    assertProjectAvailable: vi.fn(async () => {}),
    getConversation: vi.fn<ConstructorParameters<typeof CoordinatorService>[0]['getConversation']>(
      async () => null
    ),
    setTaskStatus: vi.fn(async () => {}),
    emit: vi.fn(),
    reportError: vi.fn(),
    deliver: vi.fn<ConstructorParameters<typeof CoordinatorService>[0]['deliver']>(async () => {}),
  };
  return { records, resources, deps, service: new CoordinatorService(deps) };
}
function caller(record: Coordinator, taskId = record.taskId): AgentCaller {
  return {
    projectId: record.projectId,
    taskId,
    conversationId: taskId === record.taskId ? record.conversationId : 'worker',
    providerId: 'claude',
    title: 'Agent',
    cwd: null,
  };
}
const result: TaskResult = {
  summary: 'Implemented',
  commits: ['abc'],
  checks: [{ command: 'pnpm test', passed: true, output: 'Passed' }],
  unresolved: [],
  prUrls: [],
};
async function assigned(test: ReturnType<typeof setup>) {
  const record = await test.service.ensureProject('project');
  await test.service.registerDelegation(caller(record), {
    id: 'worker-task',
    projectId: 'project',
    taskConfig: { version: '1', name: 'Implementation' },
    workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
  });
  return record;
}

describe('main agent coordination', () => {
  it('creates one stable identity on project creation without starting an agent', async () => {
    const test = setup();
    const [first, second] = await Promise.all([
      test.service.ensureProject('project'),
      test.service.ensureProject('project'),
    ]);
    expect(second).toEqual(first);
    expect(test.resources.prepare).not.toHaveBeenCalled();
    expect(test.resources.start).not.toHaveBeenCalled();
    expect(await new CoordinatorService(test.deps).ensureProject('project')).toEqual(first);
  });

  it('opens an explicit coordination runtime once and leaves the first turn to the user', async () => {
    const test = setup();
    const first = await test.service.openProject('project');
    await new CoordinatorService(test.deps).openProject('project');
    expect(test.resources.create).toHaveBeenCalledOnce();
    expect(first.params?.taskConfig.role).toBe('coordination');
    expect(first.params?.workspaceConfig.git).toMatchObject({
      branchName: `emdash/manage/${first.taskId}`,
    });
    expect(first.params?.taskConfig.initialConversation?.initialQueue).toBeUndefined();
    expect(test.resources.start).not.toHaveBeenCalled();
    expect(await test.service.instructionsForTask(first.taskId)).toContain('main agent');
  });

  it('attaches delegated tasks to one coordinator and exposes worker instructions', async () => {
    const test = setup();
    const record = await assigned(test);
    expect((await test.service.getByTask(record.taskId))?.tasks['worker-task']).toMatchObject({
      state: 'assigned',
      resultVersion: 0,
    });
    expect(await test.service.instructionsForTask('worker-task')).toContain('submit_task_result');
    expect(await test.service.instructionsForTask('ordinary-task')).toBeUndefined();
  });

  it('persists results for review, deduplicates submission and acknowledges delivery', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    const first = await test.service.submit(worker, worker.taskId, 'result-request', result);
    await test.service.deliverPending(record.id);
    expect(await test.service.submit(worker, worker.taskId, 'result-request', result)).toEqual(
      first
    );
    await test.service.deliverPending(record.id);
    const latest = await test.service.getByTask(record.taskId);
    expect(latest?.tasks[worker.taskId].state).toBe('review');
    expect(latest?.events).toHaveLength(1);
    expect(test.deps.deliver).toHaveBeenCalledOnce();
    expect(test.deps.setTaskStatus).not.toHaveBeenCalledWith(worker.taskId, 'done');
    await test.service.acknowledge(caller(record), [first.eventId]);
    await test.service.acknowledge(caller(record), [first.eventId]);
    expect((await test.service.getByTask(record.taskId))?.events[0].state).toBe('acknowledged');
  });

  it('requires explicit review of the latest result and never reopens an accepted result on retry', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    await expect(test.service.review(record.id, worker.taskId, true, 'Checked', 1)).rejects.toThrow(
      'no submitted result'
    );
    await test.service.submit(worker, worker.taskId, 'one', result);
    await test.service.review(record.id, worker.taskId, true, 'Checked diff and tests', 1);
    test.deps.setTaskStatus.mockClear();
    await test.service.submit(worker, worker.taskId, 'one', result);
    expect(test.deps.setTaskStatus).not.toHaveBeenCalledWith(worker.taskId, 'review');
    expect((await test.service.getByTask(record.taskId))?.tasks[worker.taskId].state).toBe('done');
    await test.service.submit(worker, worker.taskId, 'two', { ...result, summary: 'Updated' });
    await expect(
      test.service.review(record.id, worker.taskId, true, 'Stale review', 1)
    ).rejects.toThrow('result changed');
  });

  it('retains results and their original versions across delivery failure and service recreation', async () => {
    const test = setup();
    const record = await assigned(test);
    test.deps.deliver.mockRejectedValue(new Error('Main agent offline'));
    const worker = caller(record, 'worker-task');
    await test.service.submit(worker, worker.taskId, 'one', result);
    await test.service.deliverPending(record.id);
    await test.service.submit(worker, worker.taskId, 'two', {
      ...result,
      summary: 'Second revision',
    });
    await test.service.deliverPending(record.id);
    expect((await test.service.getByTask(record.taskId))?.events[0]).toMatchObject({
      state: 'pending',
      error: 'Main agent offline',
    });
    test.deps.deliver.mockReset();
    test.deps.deliver.mockResolvedValue(undefined);
    await new CoordinatorService(test.deps).deliverPending(record.id);
    expect(test.deps.deliver).toHaveBeenCalledTimes(2);
    expect(test.deps.deliver.mock.calls[0][2]).toContain('"summary":"Implemented"');
    expect(test.deps.deliver.mock.calls[1][2]).toContain('Second revision');
  });

  it('rejects foreign submissions, reused result IDs and worker acknowledgments', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    await expect(
      test.service.submit(caller(record, 'stranger'), worker.taskId, 'one', result)
    ).rejects.toThrow('not assigned');
    const receipt = await test.service.submit(worker, worker.taskId, 'one', result);
    await expect(
      test.service.submit(worker, worker.taskId, 'one', { ...result, summary: 'Changed' })
    ).rejects.toThrow('different content');
    await expect(test.service.acknowledge(worker, [receipt.eventId])).rejects.toThrow(
      'Only the responsible'
    );
  });

  it('serializes concurrent submissions and repairs a result saved before its status write failed', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    test.deps.setTaskStatus.mockRejectedValueOnce(new Error('Status write interrupted'));
    await expect(test.service.submit(worker, worker.taskId, 'first', result)).rejects.toThrow(
      'interrupted'
    );
    const receipts = await Promise.all([
      test.service.submit(worker, worker.taskId, 'first', result),
      test.service.submit(worker, worker.taskId, 'first', result),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect((await test.service.getByTask(record.taskId))?.events).toHaveLength(1);
    expect(test.deps.setTaskStatus).toHaveBeenLastCalledWith(worker.taskId, 'review');
  });

  it('recovers queued but unacknowledged events and leaves acknowledged events consumed', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    const receipt = await test.service.submit(worker, worker.taskId, 'first', result);
    await test.service.deliverPending(record.id);
    test.deps.deliver.mockClear();
    const restarted = new CoordinatorService(test.deps);
    await restarted.recover();
    expect(test.deps.deliver).toHaveBeenCalledOnce();
    expect(test.deps.deliver.mock.calls[0][1]).toBe(receipt.eventId);
    await restarted.acknowledge(caller(record), [receipt.eventId]);
    test.deps.deliver.mockClear();
    await new CoordinatorService(test.deps).recover();
    expect(test.deps.deliver).not.toHaveBeenCalled();
  });

  it('preserves an early acknowledgment received before delivery confirms', async () => {
    const test = setup();
    const record = await assigned(test);
    test.deps.deliver.mockImplementation(async (_record, eventId) => {
      await test.service.acknowledge(caller(record), [eventId]);
    });
    await test.service.submit(caller(record, 'worker-task'), 'worker-task', 'first', result);
    await test.service.deliverPending(record.id);
    expect((await test.service.getByTask(record.taskId))?.events[0].state).toBe('acknowledged');
  });

  it('keeps durable review decisions when status projection fails and repairs them on restart', async () => {
    const test = setup();
    const record = await assigned(test);
    await test.service.submit(caller(record, 'worker-task'), 'worker-task', 'first', result);
    await test.service.deliverPending(record.id);
    test.deps.setTaskStatus.mockRejectedValueOnce(new Error('Status write interrupted'));
    await expect(test.service.review(record.id, 'worker-task', true, 'Checked', 1)).rejects.toThrow(
      'interrupted'
    );
    expect((await test.service.getByTask(record.taskId))?.tasks['worker-task'].state).toBe('done');
    await new CoordinatorService(test.deps).recover();
    expect(test.deps.setTaskStatus).toHaveBeenLastCalledWith('worker-task', 'done');
  });

  it('isolates malformed coordinator data during listing and recovery', async () => {
    const test = setup();
    const record = await test.service.ensureProject('project');
    test.records.set('broken', { version: 'unrecognized' } as unknown as Coordinator);
    expect(await test.service.list()).toEqual([record]);
    await test.service.recover();
    expect(test.deps.reportError).toHaveBeenCalledWith(expect.anything(), 'broken');
    expect(await test.service.getByTask(record.taskId)).toEqual(record);
  });

  it('switches the result receiver without changing its identity, tasks or confirmed events', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    const first = await test.service.submit(worker, worker.taskId, 'first', result);
    await test.service.deliverPending(record.id);
    await test.service.acknowledge(caller(record), [first.eventId]);
    const second = await test.service.submit(worker, worker.taskId, 'second', {
      ...result,
      summary: 'Updated',
    });
    await test.service.deliverPending(record.id);
    test.deps.getConversation.mockResolvedValue({
      taskId: record.taskId,
      projectId: record.projectId,
      selection: { agent: 'codex' },
    });
    test.deps.deliver.mockClear();
    const switched = await test.service.bindConversation(record.id, 'replacement-main');
    await test.service.deliverPending(record.id);
    expect(switched.id).toBe(record.id);
    expect(switched.taskId).toBe(record.taskId);
    expect(switched.conversationId).toBe('replacement-main');
    expect(switched.primary).toEqual({ agent: 'codex' });
    expect(switched.tasks[worker.taskId].resultVersion).toBe(2);
    expect(test.deps.deliver).toHaveBeenCalledOnce();
    expect(test.deps.deliver.mock.calls[0][0].conversationId).toBe('replacement-main');
    expect(test.deps.deliver.mock.calls[0][1]).toBe(second.eventId);
    await expect(test.service.acknowledge(caller(record), [second.eventId])).rejects.toThrow(
      'responsible main conversation'
    );
    await test.service.acknowledge({ ...caller(record), conversationId: 'replacement-main' }, [
      second.eventId,
    ]);
    const saved = await new CoordinatorService(test.deps).getByTask(record.taskId);
    expect(saved?.conversationId).toBe('replacement-main');
    expect(saved?.events.every((event) => event.state === 'acknowledged')).toBe(true);
  });

  it('rechecks consumption authority inside the lock when switching races an acknowledgment', async () => {
    const test = setup();
    const record = await assigned(test);
    const receipt = await test.service.submit(
      caller(record, 'worker-task'),
      'worker-task',
      'first',
      result
    );
    await test.service.deliverPending(record.id);
    const entered = deferred<void>();
    const resume = deferred<void>();
    test.deps.getConversation.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return { taskId: record.taskId, projectId: record.projectId, selection: { agent: 'claude' } };
    });
    const switching = test.service.bindConversation(record.id, 'replacement-main');
    await entered.promise;
    const read = deferred<void>();
    vi.spyOn(test.deps.store, 'getAll').mockImplementationOnce(async () => {
      const snapshot = structuredClone(Object.fromEntries(test.records));
      read.resolve();
      return snapshot;
    });
    const acknowledgment = test.service.acknowledge(caller(record), [receipt.eventId]);
    const rejected = expect(acknowledgment).rejects.toThrow('responsible main conversation');
    await read.promise;
    resume.resolve();
    await switching;
    await rejected;
    await expect(
      test.service.review(record.id, 'worker-task', true, 'Stale main', 1, caller(record))
    ).rejects.toThrow('responsible main conversation');
    expect((await test.service.getByTask(record.taskId))?.events[0].state).not.toBe('acknowledged');
  });

  it('rejects missing and foreign main conversations without changing the receiver', async () => {
    const test = setup();
    const record = await test.service.ensureProject('project');
    await expect(test.service.bindConversation(record.id, 'missing')).rejects.toThrow(
      'belonging to this main agent'
    );
    test.deps.getConversation.mockResolvedValue({
      taskId: 'foreign',
      projectId: record.projectId,
      selection: { agent: 'claude' },
    });
    await expect(test.service.bindConversation(record.id, 'foreign')).rejects.toThrow(
      'belonging to this main agent'
    );
    expect((await test.service.getByTask(record.taskId))?.conversationId).toBe(
      record.conversationId
    );
  });

  it('stores explicit worker grants and prevents children from expanding beyond their parent', async () => {
    const test = setup();
    const record = await assigned(test);
    const worker = caller(record, 'worker-task');
    await expect(test.service.assertDelegationGrants(worker, ['other'])).rejects.toThrow(
      'permission denied'
    );
    await test.service.registerDelegation(
      caller(record),
      {
        id: 'granted-worker',
        projectId: 'other',
        taskConfig: { version: '1', name: 'Granted' },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: { kind: 'new-worktree' },
        },
      },
      ['project']
    );
    const granted = { ...caller(record, 'granted-worker'), projectId: 'other' };
    await test.service.assertDelegationGrants(granted, ['project']);
    await expect(test.service.assertDelegationGrants(granted, ['ungranted'])).rejects.toThrow(
      'permission denied'
    );
    const restored = new CoordinatorService(test.deps);
    expect(
      (await restored.getByTask(record.taskId))?.tasks['granted-worker'].grantedProjectIds
    ).toEqual(['project']);
    await restored.update(record.id, {
      projectAccess: { mode: 'selected', projectIds: ['other'] },
      projectIds: ['project', 'other'],
    });
    expect(await restored.mayAccessProject(granted, 'project', 'delegate')).toBe(false);
    expect(
      await restored.mayAccessTask(granted, { id: 'granted-worker', projectId: 'other' }, 'control')
    ).toBe(true);
  });

  it('upgrades version 1 records and refuses to overwrite future coordination data', async () => {
    const test = setup();
    const record = await test.service.ensureProject('project');
    test.records.set(record.id, { ...record, version: '1' } as unknown as Coordinator);
    expect((await test.service.ensureProject('project')).version).toBe('2');
    await test.service.update(record.id, {
      projectAccess: { mode: 'selected', projectIds: ['project'] },
    });
    expect(test.records.get(record.id)?.version).toBe('2');
    test.records.set(record.id, { ...record, version: '99' } as unknown as Coordinator);
    await expect(test.service.update(record.id, { projectIds: [] })).rejects.toThrow(
      'future-version'
    );
    expect((test.records.get(record.id) as unknown as { version: string }).version).toBe('99');
  });

  it('creates independent cross-project main agents idempotently without allocating runtime resources', async () => {
    const test = setup();
    const project = await test.service.ensureProject('project');
    const input = {
      id: 'cross-request',
      name: 'Business integration',
      projectId: 'project',
      projectIds: ['other'],
      primary: { agent: 'opencode' },
    };
    const [one, two] = await Promise.all([
      test.service.createCrossProject(input),
      test.service.createCrossProject(input),
    ]);
    expect(two).toEqual(one);
    expect(one.kind).toBe('cross-project');
    expect(one.projectIds).toEqual(['other', 'project']);
    expect(one.taskId).not.toBe(project.taskId);
    expect(test.resources.prepare).not.toHaveBeenCalled();
    expect(
      (await test.service.list()).filter((record) => record.kind === 'cross-project')
    ).toHaveLength(1);
    await expect(test.service.createCrossProject({ ...input, name: 'Changed' })).rejects.toThrow(
      'different main agent parameters'
    );
    expect((await new CoordinatorService(test.deps).createCrossProject(input)).id).toBe(one.id);
  });

  it('uses the configured default worker agent independently of the primary agent', async () => {
    const test = setup();
    const record = await test.service.ensureProject('project');
    await test.service.update(record.id, { primary: { agent: 'opencode' } });
    expect(
      await test.service.defaultsForCaller({ ...caller(record), providerId: 'opencode' })
    ).toEqual({ agent: 'claude' });
    expect(await test.service.defaultsForCaller(caller(record, 'ordinary'))).toEqual({});
    const preview = await test.service.selectionOptions(record.id, {});
    expect(preview.values.agent).toBe('claude');
  });

  it('keeps delegation defaults independent of the main conversation', async () => {
    const test = setup();
    const record = await test.service.ensureProject('project');
    await test.service.update(record.id, {
      delegationDefaults: { agent: 'codex', effort: 'high', model: 'code' },
    });
    expect(await test.service.defaultsForCaller(caller(record))).toMatchObject({
      agent: 'codex',
      effort: 'high',
    });
    expect((await test.service.getByTask(record.taskId))?.primary.agent).toBe('claude');
  });
});
