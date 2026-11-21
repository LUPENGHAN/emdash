import { createHash, randomUUID } from 'node:crypto';
import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import { deferred } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { DelegationResources } from '@core/features/agent-control/api/node/delegation-resources';
import type { ManagementDocument } from '../api/documents';
import type { Coordinator, TaskResult, DocumentStorage } from '../api/types';
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
      setManyOrThrow: vi.fn(async (entries: { key: string; value: Coordinator }[]) => {
        for (const entry of entries) records.set(entry.key, structuredClone(entry.value));
      }),
      setOrThrow: async (id: string, value: Coordinator) => {
        records.set(id, structuredClone(value));
      },
    },
    getTask: vi.fn<ConstructorParameters<typeof CoordinatorService>[0]['getTask']>(async (id) => {
      const record = [...records.values()].find((record) => record.tasks[id]);
      const task = record?.tasks[id];
      return task ? { id, projectId: task.projectId, name: task.name, type: 'task' } : null;
    }),
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
  await test.service.markTaskCreated('worker-task');
  return record;
}

describe('main agent coordination', () => {
  it('lets the desktop retry an owned startup through the bound receiver and reports its state', async () => {
    const test = setup();
    const main = await assigned(test);
    vi.mocked(test.deps.getConversation).mockResolvedValue({
      taskId: main.taskId,
      projectId: main.projectId,
      selection: { agent: 'opencode' },
    });
    const status = vi.fn(async () => ({
      taskId: 'worker-task',
      phase: 'starting' as const,
      error: 'Disconnected',
      canRetry: true,
    }));
    const retry = vi.fn(async () => ({ text: 'started' }));
    const service = new CoordinatorService({ ...test.deps, delegations: { status, retry } });
    expect(await service.delegationStatus(main.id, 'worker-task')).toMatchObject({
      canRetry: true,
    });
    await service.retryTask(main.id, 'worker-task');
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: main.taskId,
        conversationId: main.conversationId,
        providerId: 'opencode',
      }),
      'worker-task'
    );
    await expect(service.retryTask(main.id, 'other-task')).rejects.toThrow('does not own');
    await expect(service.delegationStatus(main.id, 'other-task')).rejects.toThrow('does not own');
    vi.mocked(test.deps.getConversation).mockResolvedValue(null);
    await expect(service.retryTask(main.id, 'worker-task')).rejects.toThrow('unavailable');
    expect(retry).toHaveBeenCalledOnce();
  });

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
      kind: 'management',
      branchName: `emdash/manage/${first.taskId}`,
    });
    expect(first.params?.taskConfig.initialConversation?.initialQueue).toBeUndefined();
    expect(test.resources.start).not.toHaveBeenCalled();
    expect(await test.service.instructionsForTask(first.taskId)).toContain('Main Agent');
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

  it('accepts only one decision for a result version and preserves it across retries and recovery', async () => {
    const test = setup();
    const record = await assigned(test);
    await test.service.submit(caller(record, 'worker-task'), 'worker-task', 'first', result);
    const decisions = await Promise.allSettled([
      test.service.review(record.id, 'worker-task', true, 'Verified', 1),
      test.service.review(record.id, 'worker-task', false, 'Stale window feedback', 1),
    ]);
    expect(decisions.map((entry) => entry.status)).toEqual(['fulfilled', 'rejected']);
    const saved = (await test.service.getByTask(record.taskId))?.tasks['worker-task'];
    expect(saved?.state).toBe('done');
    expect(saved?.review).toMatchObject({ accepted: true, note: 'Verified' });
    const restored = new CoordinatorService(test.deps);
    test.deps.setTaskStatus.mockRejectedValueOnce(new Error('Projection interrupted'));
    await expect(restored.review(record.id, 'worker-task', true, 'Verified', 1)).rejects.toThrow(
      'Projection interrupted'
    );
    await restored.review(record.id, 'worker-task', true, 'Verified', 1);
    expect((await restored.getByTask(record.taskId))?.tasks['worker-task'].review).toEqual(
      saved?.review
    );
    await expect(
      restored.review(record.id, 'worker-task', true, 'Different note', 1)
    ).rejects.toThrow('already reviewed');
    await restored.submit(caller(record, 'worker-task'), 'worker-task', 'second', {
      ...result,
      summary: 'Another result version',
    });
    await restored.review(record.id, 'worker-task', false, 'Review version two', 2);
    expect((await restored.getByTask(record.taskId))?.tasks['worker-task'].state).toBe(
      'changes_requested'
    );
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
    expect(test.deps.deliver.mock.calls[0][2]).toContain('submitted a result');
    expect(test.deps.deliver.mock.calls[0][2]).not.toContain('request_id');
    expect(test.deps.deliver.mock.calls[0][3]).toContain('"summary":"Implemented"');
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
      'conversation in this main agent'
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
    await test.service.acknowledge(caller(record), [second.eventId]);
    await test.service.acknowledge({ ...caller(record), conversationId: 'replacement-main' }, [
      second.eventId,
    ]);
    const saved = await new CoordinatorService(test.deps).getByTask(record.taskId);
    expect(saved?.conversationId).toBe('replacement-main');
    expect(saved?.events.every((event) => event.state === 'acknowledged')).toBe(true);
  });

  it('keeps every main-task conversation authorized while the notification receiver changes', async () => {
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
    await read.promise;
    resume.resolve();
    await switching;
    await acknowledgment;
    await test.service.review(
      record.id,
      'worker-task',
      true,
      'Main-task review',
      1,
      caller(record)
    );
    expect((await test.service.getByTask(record.taskId))?.events[0].state).toBe('acknowledged');
    expect((await test.service.getByTask(record.taskId))?.tasks['worker-task'].state).toBe('done');
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
    expect((await test.service.ensureProject('project')).version).toBe('10');
    await test.service.update(record.id, {
      projectAccess: { mode: 'selected', projectIds: ['project'] },
    });
    expect(test.records.get(record.id)?.version).toBe('10');
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
    expect(one.projectIds).toEqual(['other']);
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

  it('persists idempotent workspace work items separately from task results', async () => {
    const test = setup();
    const record = await test.service.createCrossProject({
      id: 'workspace',
      name: '分析缓存数据',
      purpose: '找出缓存命中率异常的原因',
      lifecycle: { kind: 'finite', state: 'active' },
      projectId: 'project',
      projectIds: [],
    });
    const input = {
      requestId: '5d5a4879-01a0-47d6-a65b-6af9709d3786',
      title: '核对统计口径',
      detail: '不创建代码任务',
    };
    const first = await test.service.addWorkItem(record.id, input);
    const repeated = await test.service.addWorkItem(record.id, input);
    expect(repeated.workItems).toEqual(first.workItems);
    expect(Object.keys(first.tasks)).toHaveLength(0);
    await expect(test.service.setLifecycleState(record.id, 'complete')).rejects.toThrow(
      'work items'
    );
    const done = await test.service.updateWorkItem(record.id, input.requestId, { state: 'done' });
    expect(done.workItems[input.requestId]).toMatchObject({
      state: 'done',
      resolvedAt: expect.any(Number),
    });
    expect((await test.service.setLifecycleState(record.id, 'complete')).lifecycle).toMatchObject({
      kind: 'finite',
      state: 'completed',
      completedAt: expect.any(Number),
    });
  });

  it('checkpoints and pauses ongoing work without completing it', async () => {
    const test = setup();
    const record = await test.service.ensureProject('project');
    const checkpoint = await test.service.checkpoint(
      record.id,
      '44dcf9f7-7398-47fa-bf1d-5bc65e78651b',
      '第一阶段'
    );
    expect(checkpoint.lifecycle).toMatchObject({
      kind: 'ongoing',
      state: 'active',
      lastCheckpointAt: expect.any(Number),
    });
    expect(checkpoint.checkpoints).toHaveLength(1);
    expect(
      (await test.service.checkpoint(record.id, '44dcf9f7-7398-47fa-bf1d-5bc65e78651b', '第一阶段'))
        .checkpoints
    ).toHaveLength(1);
    expect((await test.service.setLifecycleState(record.id, 'pause')).lifecycle.state).toBe(
      'paused'
    );
    expect((await test.service.setLifecycleState(record.id, 'resume')).lifecycle.state).toBe(
      'active'
    );
    await expect(test.service.setLifecycleState(record.id, 'complete')).rejects.toThrow(
      'checkpoints'
    );
  });

  it('transfers one owner atomically, preserves result history and redirects unconfirmed events', async () => {
    const test = setup();
    const source = await assigned(test);
    const destination = await test.service.ensureProject('other');
    const receipt = await test.service.submit(
      caller(source, 'worker-task'),
      'worker-task',
      'first',
      result
    );
    await test.service.deliverPending(source.id);
    const switched = await test.service.takeOverTask(
      destination.id,
      'worker-task',
      source.id,
      caller(destination)
    );
    await test.service.deliverPending(destination.id);
    expect((await test.service.getByTask(source.taskId))?.tasks['worker-task']).toBeUndefined();
    expect(switched.tasks['worker-task'].result).toEqual(result);
    expect(switched.tasks['worker-task'].ownershipHistory).toEqual([
      { from: source.id, to: destination.id, at: expect.any(Number) },
    ]);
    expect((await test.service.getByTask(source.taskId))?.events).toEqual([]);
    expect(test.deps.store.setManyOrThrow).toHaveBeenCalledOnce();
    expect(test.deps.deliver.mock.calls.at(-1)?.[0].id).toBe(destination.id);
    await expect(test.service.acknowledge(caller(source), [receipt.eventId])).rejects.toThrow(
      'Unknown result'
    );
    await test.service.acknowledge(caller(destination), [receipt.eventId]);
    await expect(
      test.service.review(source.id, 'worker-task', true, 'Old owner', 1, caller(source))
    ).rejects.toThrow('no submitted result');
    await test.service.review(
      destination.id,
      'worker-task',
      true,
      'Checked',
      1,
      caller(destination)
    );
    expect(
      (await test.service.takeOverTask(destination.id, 'worker-task', source.id)).tasks[
        'worker-task'
      ].ownershipHistory
    ).toHaveLength(1);
  });

  it('allows only one concurrent destination to acquire a task with the expected owner', async () => {
    const test = setup();
    const source = await assigned(test);
    const one = await test.service.ensureProject('one');
    const two = await test.service.ensureProject('two');
    const outcomes = await Promise.allSettled([
      test.service.takeOverTask(one.id, 'worker-task', source.id),
      test.service.takeOverTask(two.id, 'worker-task', source.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await test.service.list()).filter((record) => record.tasks['worker-task'])
    ).toHaveLength(1);
  });

  it('leaves the source owner untouched when the atomic commit fails', async () => {
    const test = setup();
    const source = await assigned(test);
    const destination = await test.service.ensureProject('other');
    test.deps.store.setManyOrThrow.mockRejectedValueOnce(new Error('Commit failed'));
    await expect(
      test.service.takeOverTask(destination.id, 'worker-task', source.id)
    ).rejects.toThrow('Commit failed');
    expect((await test.service.getByTask(source.taskId))?.tasks['worker-task']).toBeDefined();
    expect(
      (await test.service.getByTask(destination.taskId))?.tasks['worker-task']
    ).toBeUndefined();
  });

  it('rejects stale owners, foreign callers, unavailable tasks and disallowed projects', async () => {
    const test = setup();
    const source = await assigned(test);
    const destination = await test.service.ensureProject('other');
    await expect(test.service.takeOverTask(destination.id, 'worker-task', null)).rejects.toThrow(
      'owner changed'
    );
    await expect(
      test.service.takeOverTask(destination.id, 'worker-task', source.id, caller(source))
    ).rejects.toThrow('conversation in this main agent');
    await expect(test.service.takeOverTask(destination.id, 'missing', null)).rejects.toThrow(
      'unavailable'
    );
    await test.service.update(destination.id, {
      projectAccess: { mode: 'selected', projectIds: [] },
    });
    await expect(
      test.service.takeOverTask(destination.id, 'worker-task', source.id)
    ).rejects.toThrow('permission denied');
    test.deps.getTask.mockResolvedValueOnce({
      id: 'automation',
      projectId: 'project',
      name: 'Run',
      type: 'automation-run',
    });
    await expect(test.service.takeOverTask(destination.id, 'automation', null)).rejects.toThrow(
      'automation runs'
    );
  });

  it('never treats an unreadable main or task owner as an ordinary unscoped caller', async () => {
    const test = setup();
    const source = await assigned(test);
    test.records.set(source.id, {
      ...test.records.get(source.id)!,
      version: '99',
    } as unknown as Coordinator);
    await expect(
      test.service.mayAccessProject(caller(source), 'project', 'delegate')
    ).rejects.toThrow('future-version');
    const ordinary = { ...caller(source), taskId: 'ordinary' };
    await expect(
      test.service.mayAccessTask(ordinary, { id: 'worker-task', projectId: 'project' }, 'control')
    ).rejects.toThrow('future-version');
  });

  it('adopts an unowned code task without creating a workspace or restarting its agent', async () => {
    const test = setup();
    const destination = await test.service.ensureProject('project');
    test.deps.getTask.mockResolvedValue({
      id: 'unowned',
      projectId: 'project',
      name: 'Existing code task',
      type: 'task',
    });
    const adopted = await test.service.takeOverTask(destination.id, 'unowned', null);
    expect(adopted.tasks.unowned.name).toBe('Existing code task');
    expect(adopted.tasks.unowned.ownershipHistory?.[0].from).toBeNull();
    expect(test.resources.create).not.toHaveBeenCalled();
    expect(test.resources.start).not.toHaveBeenCalled();
  });

  it('rechecks the target project when a prepared worker delegation is registered after its grants change', async () => {
    const test = setup();
    const record = await assigned(test);
    const stored = test.records.get(record.id)!;
    stored.tasks['worker-task'].grantedProjectIds = [];
    await expect(
      test.service.registerDelegation(caller(record, 'worker-task'), {
        id: 'late-child',
        projectId: 'other',
        taskConfig: { version: '1', name: 'Late child' },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: { kind: 'new-worktree' },
        },
      })
    ).rejects.toThrow('permission denied');
    expect((await test.service.getByTask(record.taskId))?.tasks['late-child']).toBeUndefined();
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

describe('prerequisite result scheduling', () => {
  const plan = (id: string, projectId = 'project') => ({
    id,
    projectId,
    taskConfig: { version: '1' as const, name: id },
    workspaceConfig: {
      version: '2' as const,
      git: { kind: 'none' as const },
      workspace: { kind: 'new-worktree' as const },
    },
  });
  it('holds resources until review and freezes the accepted result version across recovery', async () => {
    const test = setup();
    const main = await assigned(test);
    await test.service.registerDelegation(caller(main), plan('dependent'), [], ['worker-task']);
    expect(await test.service.plannedTasks('project')).toMatchObject([
      { taskId: 'dependent', taskCreated: false },
    ]);
    expect(await test.service.dependencyGate('dependent')).toContain('Waiting for review');
    await expect(
      test.service.submit(caller(main, 'dependent'), 'dependent', 'premature', result)
    ).rejects.toThrow('not been created');
    await test.service.submit(caller(main, 'worker-task'), 'worker-task', 'first', result);
    expect(await test.service.dependencyGate('dependent')).toContain('Waiting for review');
    await test.service.review(main.id, 'worker-task', false, 'Fix tests', 1);
    expect(await test.service.dependencyGate('dependent')).toContain('Waiting for review');
    await test.service.submit(caller(main, 'worker-task'), 'worker-task', 'second', {
      ...result,
      commits: ['verified'],
    });
    await test.service.review(main.id, 'worker-task', true, 'Checked', 2);
    expect(await new CoordinatorService(test.deps).dependencyGate('dependent')).toBeNull();
    expect((await test.service.getTaskCoordination('dependent'))?.assignment).toMatchObject({
      state: 'assigned',
      taskCreated: false,
      dependencyResults: [
        { taskId: 'worker-task', projectId: 'project', version: 2, commits: ['verified'] },
      ],
    });
    expect(await test.service.instructionsForTask('dependent')).toContain('verified');
    await test.service.submit(caller(main, 'worker-task'), 'worker-task', 'third', {
      ...result,
      commits: ['another'],
    });
    expect(await test.service.dependencyGate('dependent')).toBeNull();
    expect(
      (await test.service.getTaskCoordination('dependent'))?.assignment?.dependencyResults?.[0]
        .version
    ).toBe(2);
    expect(test.resources.create).not.toHaveBeenCalled();
    expect(test.resources.start).not.toHaveBeenCalled();
  });
  it('rejects unknown, self, cyclic and unauthorized prerequisite references', async () => {
    const test = setup();
    const main = await assigned(test);
    await expect(
      test.service.registerDelegation(caller(main), plan('missing'), [], ['unknown'])
    ).rejects.toThrow('existing coordinated task');
    await expect(
      test.service.registerDelegation(caller(main), plan('self'), [], ['self'])
    ).rejects.toThrow('existing coordinated task');
    const stored = test.records.get(main.id)!;
    stored.tasks['worker-task'].dependsOn = ['cyclic'];
    test.records.set(main.id, stored);
    await expect(
      test.service.registerDelegation(caller(main), plan('cyclic'), [], ['worker-task'])
    ).rejects.toThrow('cycle');
    const other = await test.service.ensureProject('other');
    await test.service.registerDelegation(caller(other), plan('foreign', 'other'));
    await test.service.update(main.id, {
      projectAccess: { mode: 'selected', projectIds: ['project'] },
    });
    await expect(
      test.service.registerDelegation(caller(main), plan('unauthorized'), [], ['foreign'])
    ).rejects.toThrow('permission denied');
    await expect(
      test.service.registerDelegation(
        { ...caller(main), taskId: 'ordinary', conversationId: 'ordinary' },
        plan('ordinary'),
        [],
        ['worker-task']
      )
    ).rejects.toThrow('responsible main agent');
    expect((await test.service.getByTask(main.taskId))?.tasks.missing).toBeUndefined();
  });
  it('does not release a dependent task when the approved prerequisite was deleted', async () => {
    const test = setup();
    const main = await assigned(test);
    await test.service.registerDelegation(caller(main), plan('dependent'), [], ['worker-task']);
    await test.service.submit(caller(main, 'worker-task'), 'worker-task', 'result', result);
    await test.service.review(main.id, 'worker-task', true, 'Checked', 1);
    test.deps.getTask.mockResolvedValue(null);
    expect(await test.service.dependencyGate('dependent')).toContain('unavailable');
    expect((await test.service.getTaskCoordination('dependent'))?.assignment?.state).toBe(
      'blocked'
    );
  });
  it('transfers a planned task without runtime resources and recovers using its current owner', async () => {
    const test = setup();
    const main = await assigned(test);
    await test.service.registerDelegation(
      caller(main),
      plan('dependent'),
      ['project'],
      ['worker-task']
    );
    const target = await test.service.ensureProject('target');
    test.deps.getTask.mockImplementation(async (id) =>
      id === 'worker-task' ? { id, projectId: 'project', name: id, type: 'task' } : null
    );
    expect((await test.service.inspectTask(target.id, 'dependent')).ownerId).toBe(main.id);
    await test.service.takeOverTask(target.id, 'dependent', main.id, caller(target));
    const restored = new CoordinatorService(test.deps);
    expect(await restored.recoveryContext('dependent', caller(main))).toMatchObject({
      caller: { conversationId: target.conversationId, taskId: target.taskId },
      projectGrants: ['project'],
    });
    await restored.markTaskCreated('dependent');
    expect((await restored.getTaskCoordination('dependent'))?.assignment?.taskCreated).toBe(true);
    expect(test.resources.create).not.toHaveBeenCalled();
  });
});

it('keeps cancelled plans blocked after review, restart and repeated cancellation', async () => {
  const test = setup();
  const main = await assigned(test);
  await test.service.registerDelegation(
    caller(main),
    {
      id: 'cancelled',
      projectId: 'project',
      taskConfig: { version: '1', name: 'Cancel me' },
      workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    },
    [],
    ['worker-task']
  );
  await test.service.cancelPendingTask(main.id, 'cancelled', {
    ...caller(main),
    conversationId: 'another-main-task-conversation',
  });
  await test.service.cancelPendingTask(main.id, 'cancelled', caller(main));
  await test.service.cancelPendingTask(main.id, 'cancelled', caller(main));
  await test.service.submit(caller(main, 'worker-task'), 'worker-task', 'result', result);
  await test.service.review(main.id, 'worker-task', true, 'Checked', 1);
  expect(await new CoordinatorService(test.deps).dependencyGate('cancelled')).toContain(
    'cancelled'
  );
  expect((await test.service.getTaskCoordination('cancelled'))?.assignment?.state).toBe(
    'cancelled'
  );
  expect(test.resources.create).not.toHaveBeenCalled();
});

it('does not admit a planned dependency after the main agent project scope narrows', async () => {
  const test = setup();
  const main = await assigned(test);
  const other = await test.service.ensureProject('other');
  await test.service.registerDelegation(
    caller(other),
    {
      id: 'dependent',
      projectId: 'other',
      taskConfig: { version: '1', name: 'Dependent' },
      workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    },
    [],
    ['worker-task']
  );
  await test.service.submit(caller(main, 'worker-task'), 'worker-task', 'result', result);
  await test.service.review(main.id, 'worker-task', true, 'Checked', 1);
  await test.service.update(other.id, {
    projectAccess: { mode: 'selected', projectIds: ['other'] },
  });
  expect(await test.service.dependencyGate('dependent')).toContain('outside');
  await test.service.update(other.id, { projectAccess: { mode: 'all' } });
  expect(await test.service.dependencyGate('dependent')).toBeNull();
  await expect(test.service.cancelPendingTask(other.id, 'dependent')).rejects.toThrow('admitted');
});

it('allows explicit user handling of an undelivered result without completing or replaying the task', async () => {
  const test = setup();
  const main = await assigned(test);
  test.deps.deliver.mockRejectedValue(new Error('Terminal main requires manual delivery'));
  const receipt = await test.service.submit(
    caller(main, 'worker-task'),
    'worker-task',
    'result',
    result
  );
  await test.service.deliverPending(main.id);
  await test.service.resolveResultEventForUser(main.id, receipt.eventId);
  await test.service.resolveResultEventForUser(main.id, receipt.eventId);
  test.deps.deliver.mockClear();
  await new CoordinatorService(test.deps).recover();
  const restored = await test.service.getByTask(main.taskId);
  expect(restored?.tasks['worker-task'].state).toBe('review');
  expect(restored?.events[0]).toMatchObject({ state: 'acknowledged', error: undefined });
  expect(test.deps.deliver).not.toHaveBeenCalled();
  await expect(test.service.resolveResultEventForUser(main.id, 'foreign-event')).rejects.toThrow(
    'no longer assigned'
  );
});

it('preserves a legacy main checkout until its separate document migration runs', async () => {
  const test = setup();
  const first = await test.service.openProject('project');
  const saved = test.records.get(first.id);
  if (!saved?.params) throw new Error('Missing main runtime');
  saved.params.workspaceConfig.git = {
    kind: 'create-branch',
    branchName: `emdash/manage/${first.taskId}`,
    fromBranch: { type: 'local', branch: 'main' },
  };
  test.records.set(first.id, { ...saved, version: '4' } as unknown as Coordinator);
  vi.mocked(test.resources.prepare).mockClear();
  vi.mocked(test.resources.create).mockClear();
  const reopened = await new CoordinatorService(test.deps).open(first.id);
  expect(reopened.version).toBe('10');
  expect(reopened.params?.workspaceConfig.git).toEqual(saved.params.workspaceConfig.git);
  expect(reopened.taskId).toBe(first.taskId);
  expect(reopened.conversationId).toBe(first.conversationId);
  expect(test.resources.prepare).not.toHaveBeenCalled();
  expect(test.resources.create).not.toHaveBeenCalled();
});

it('preserves a directory main workspace and its conversation across opening and service recovery', async () => {
  const test = setup();
  const record = await test.service.ensureProject('directory');
  const params = await test.resources.prepare(
    caller(record),
    { kind: 'create_task', name: record.name, projectId: record.projectId },
    { taskId: record.taskId, conversationId: record.conversationId, role: 'coordination' }
  );
  params.workspaceConfig = {
    version: '2',
    git: { kind: 'none' },
    workspace: { kind: 'repository-instance', workspaceId: 'directory-root' },
  };
  vi.mocked(test.resources.prepare).mockResolvedValue(params);
  const first = await test.service.open(record.id);
  const restored = await new CoordinatorService(test.deps).open(record.id);
  expect(first.params?.workspaceConfig).toEqual(params.workspaceConfig);
  expect(restored).toEqual(first);
  expect(first.params?.taskConfig.initialConversation?.initialQueue).toBeUndefined();
  expect(test.resources.create).toHaveBeenCalledOnce();
  expect(test.resources.start).not.toHaveBeenCalled();
});

describe('management document authorization', () => {
  it('cancels an incomplete storage setup without contacting its unavailable host or clearing ready documents', async () => {
    const test = setup();
    const main = await test.service.openProject('directory');
    const saved = test.records.get(main.id);
    if (!saved?.params) throw new Error('Missing main runtime');
    saved.params.workspaceConfig = {
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'directory-root' },
    };
    const sourceParams = structuredClone(saved.params);
    const storage: DocumentStorage = {
      projectId: 'unavailable-project',
      taskId: 'pending-documents',
      state: 'preparing',
      params: {
        ...structuredClone(sourceParams),
        id: 'pending-documents',
        projectId: 'unavailable-project',
        taskConfig: { version: '1', name: 'Documents', role: 'coordination' },
        workspaceConfig: {
          version: '2',
          git: { kind: 'management', branchName: 'emdash/manage/pending-documents' },
          workspace: { kind: 'new-worktree' },
        },
      },
    };
    saved.documentStorage = storage;
    test.records.set(saved.id, saved);
    vi.mocked(test.resources.activate).mockClear();
    await expect(test.service.cancelDocumentStorageSetup(main.id, 'superseded')).rejects.toThrow(
      'changed'
    );
    const cancelled = await test.service.cancelDocumentStorageSetup(main.id, storage.taskId);
    expect(cancelled.documentStorage).toBeUndefined();
    expect(cancelled.documentStorageHistory).toEqual([storage]);
    expect(cancelled.params).toEqual(sourceParams);
    expect(test.resources.activate).not.toHaveBeenCalled();
    expect(test.resources.start).not.toHaveBeenCalled();
    const repeated = await test.service.cancelDocumentStorageSetup(main.id, storage.taskId);
    expect(repeated.documentStorageHistory).toHaveLength(1);
    test.records.set(saved.id, { ...saved, documentStorage: { ...storage, state: 'ready' } });
    await expect(test.service.cancelDocumentStorageSetup(main.id, storage.taskId)).rejects.toThrow(
      'migration'
    );
  });

  it('sets up independent Git storage for a directory main, resuming the same resources after interruption', async () => {
    const test = setup();
    const main = await test.service.openProject('directory');
    const saved = test.records.get(main.id);
    if (!saved?.params) throw new Error('Missing main runtime');
    saved.params.workspaceConfig = {
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'directory-root' },
    };
    test.records.set(saved.id, saved);
    const original = structuredClone(saved);
    vi.mocked(test.resources.prepare).mockImplementation(async (_caller, request, ids) => ({
      id: ids.taskId,
      projectId: request.projectId!,
      taskConfig: { version: '1', name: request.name },
      workspaceConfig: {
        version: '2',
        git: { kind: 'management', branchName: `emdash/manage/${ids.taskId}` },
        workspace: { kind: 'new-worktree' },
      },
    }));
    vi.mocked(test.resources.activate).mockRejectedValueOnce(new Error('Host disconnected'));
    await expect(test.service.createDocumentStorage(main.id, 'git-project')).rejects.toThrow(
      'Host disconnected'
    );
    const pending = test.records.get(main.id)?.documentStorage;
    expect(pending?.state).toBe('preparing');
    await expect(test.service.createDocumentStorage(main.id, 'other-project')).rejects.toThrow(
      'migration'
    );
    const restarted = new CoordinatorService(test.deps);
    const restored = await restarted.createDocumentStorage(main.id, 'git-project');
    expect(restored.documentStorage).toMatchObject({
      projectId: 'git-project',
      taskId: pending?.taskId,
      state: 'ready',
    });
    expect(restored.documentStorage?.params.taskConfig.role).toBe('coordination');
    expect(restored.documentStorage?.params.taskConfig.initialConversation).toBeUndefined();
    expect(restored.params).toEqual(original.params);
    expect(restored.taskId).toBe(original.taskId);
    expect(restored.conversationId).toBe(original.conversationId);
    expect(restored.tasks).toEqual(original.tasks);
    expect(test.resources.create).toHaveBeenCalledTimes(2);
    expect(test.resources.prepare).toHaveBeenCalledTimes(2);
    expect(test.resources.start).not.toHaveBeenCalled();
    await restarted.createDocumentStorage(main.id, 'git-project');
    expect(test.resources.create).toHaveBeenCalledTimes(2);
    test.deps.assertProjectAvailable.mockImplementation(async (id?: string) => {
      if (id === 'git-project') throw new Error('Storage project archived');
    });
    const describe = vi.fn();
    const documentService = new CoordinatorService({
      ...test.deps,
      documents: { describe, create: vi.fn(), read: vi.fn() },
    });
    await expect(documentService.documentWorkspace(main.id)).rejects.toThrow(
      'Storage project archived'
    );
    expect(describe).not.toHaveBeenCalled();
    expect(test.records.get(main.id)?.documentStorage?.projectId).toBe('git-project');
  });

  it('allows every main-task conversation, but no worker, to write shared documents', async () => {
    const test = setup();
    const main = await assigned(test);
    const write = vi.fn(async () => ({
      coordinatorId: main.id,
      workspaceId: 'docs',
      path: 'plan.md',
      content: 'saved',
      revision: 'disk:etag',
    }));
    const service = new CoordinatorService({
      ...test.deps,
      documents: { write, read: vi.fn(), create: vi.fn(), describe: vi.fn() },
    });
    const input = { path: 'plan.md', content: 'saved' };
    await expect(
      service.writeDocument(main.id, input, caller(main, 'worker-task'))
    ).rejects.toThrow('conversation in this main agent');
    await service.writeDocument(main.id, input, {
      ...caller(main),
      conversationId: 'another-main-task-conversation',
    });
    await service.writeDocument(main.id, input, caller(main));
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('requires migration rather than replacing a management checkout with empty storage', async () => {
    const test = setup();
    const main = await test.service.openProject('project');
    const prepared = vi.mocked(test.resources.prepare).mock.calls.length;
    await expect(test.service.createDocumentStorage(main.id, 'other-project')).rejects.toThrow(
      'migration'
    );
    expect(test.resources.prepare).toHaveBeenCalledTimes(prepared);
    expect((await test.service.getByTask(main.taskId))?.documentStorage).toBeUndefined();
  });

  it('checks worker grants before reading and keeps them bounded by the responsible main scope', async () => {
    const { records, deps } = setup();
    const read = vi.fn(async () => ({
      coordinatorId: 'project:target',
      path: 'plan.md',
      revision: 'disk:1',
      content: 'plan',
      workspaceId: 'documents',
    }));
    const service = new CoordinatorService({
      ...deps,
      documents: { read, describe: vi.fn(), create: vi.fn() },
    });
    const main = await service.ensureProject('source');
    const target = await service.ensureProject('target');
    main.tasks.worker = {
      taskId: 'worker',
      projectId: 'source',
      name: 'Worker',
      state: 'assigned',
      resultVersion: 0,
      submissions: {},
    };
    records.set(main.id, main);
    const worker = caller(main, 'worker');
    await expect(service.readDocument(target.id, 'plan.md', undefined, worker)).rejects.toThrow(
      'permission'
    );
    expect(read).not.toHaveBeenCalled();
    main.tasks.worker.grantedProjectIds = ['target'];
    records.set(main.id, main);
    await expect(
      service.readDocument(target.id, 'plan.md', undefined, worker)
    ).resolves.toMatchObject({ content: 'plan' });
    read.mockClear();
    main.projectAccess = { mode: 'selected', projectIds: ['source'] };
    records.set(main.id, main);
    await expect(service.readDocument(target.id, 'plan.md', undefined, worker)).rejects.toThrow(
      'permission'
    );
    expect(read).not.toHaveBeenCalled();
    expect(deps.resources().create).not.toHaveBeenCalled();
  });
  it('permits the main authorized read without allocating a task or starting a process', async () => {
    const { deps } = setup();
    const read = vi.fn(async () => ({
      coordinatorId: 'project:source',
      path: 'plan.md',
      revision: 'disk:1',
      content: 'plan',
      workspaceId: 'documents',
    }));
    const service = new CoordinatorService({
      ...deps,
      documents: { read, describe: vi.fn(), create: vi.fn() },
    });
    const main = await service.ensureProject('source');
    await service.readDocument(main.id, 'plan.md', 'disk:1', caller(main));
    expect(read).toHaveBeenCalledWith(main, 'plan.md', 'disk:1');
    expect(deps.resources().activate).not.toHaveBeenCalled();
    expect(deps.resources().start).not.toHaveBeenCalled();
  });
});

describe('frozen task documents', () => {
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
  it('freezes selected content once, restores it and transfers it with task ownership', async () => {
    const { records, deps } = setup();
    let content = 'selected plan';
    const read = vi.fn(async (record: Coordinator, path: string) => ({
      coordinatorId: record.id,
      path,
      revision: 'disk:selected',
      content,
      workspaceId: 'docs',
    }));
    const make = () =>
      new CoordinatorService({ ...deps, documents: { read, create: vi.fn(), describe: vi.fn() } });
    const service = make();
    const main = await service.ensureProject('project');
    await service.registerDelegation(caller(main), plan('worker'), [], [], [{ path: 'plan.md' }]);
    content = 'changed plan';
    await make().registerDelegation(caller(main), plan('worker'), [], [], [{ path: 'plan.md' }]);
    expect(read).toHaveBeenCalledOnce();
    expect(await make().instructionsForTask('worker')).toContain('selected plan');
    expect(await make().instructionsForTask('worker')).not.toContain('changed plan');
    const worker = caller(main, 'worker');
    await expect(
      make().readDocument(main.id, 'plan.md', 'disk:selected', worker)
    ).resolves.toMatchObject({ content: 'selected plan' });
    await expect(make().readDocument(main.id, 'plan.md', undefined, worker)).resolves.toMatchObject(
      { content: 'selected plan' }
    );
    await expect(make().readDocument(main.id, 'other.md', undefined, worker)).rejects.toThrow(
      'permission'
    );
    await expect(make().readDocument(main.id, 'plan.md', 'disk:changed', worker)).rejects.toThrow(
      'permission'
    );
    const target = await service.ensureProject('target');
    await service.takeOverTask(target.id, 'worker', main.id);
    records.delete(main.id);
    await expect(
      make().readDocument(main.id, 'plan.md', 'disk:selected', worker)
    ).resolves.toMatchObject({ content: 'selected plan' });
    expect(read).toHaveBeenCalledOnce();
  });
  it('does not save a partial assignment if one selected document cannot be read', async () => {
    const { deps } = setup();
    const read = vi.fn(async (record: Coordinator, path: string) => {
      if (path === 'missing.md') throw new Error('Document missing');
      return {
        coordinatorId: record.id,
        path,
        revision: 'disk:1',
        content: 'plan',
        workspaceId: 'docs',
      };
    });
    const service = new CoordinatorService({
      ...deps,
      documents: { read, create: vi.fn(), describe: vi.fn() },
    });
    const main = await service.ensureProject('project');
    await expect(
      service.registerDelegation(
        caller(main),
        plan('worker'),
        [],
        [],
        [{ path: 'plan.md' }, { path: 'missing.md' }]
      )
    ).rejects.toThrow('Document missing');
    expect((await service.getByTask(main.taskId))?.tasks.worker).toBeUndefined();
    expect(deps.resources().create).not.toHaveBeenCalled();
  });
  it('limits selected context and refuses document references without a responsible main', async () => {
    const { deps } = setup();
    const read = vi.fn(async (record: Coordinator, path: string) => ({
      coordinatorId: record.id,
      path,
      revision: 'disk:1',
      content: 'x'.repeat(500 * 1024),
      workspaceId: 'docs',
    }));
    const service = new CoordinatorService({
      ...deps,
      documents: { read, create: vi.fn(), describe: vi.fn() },
    });
    const main = await service.ensureProject('project');
    await expect(
      service.registerDelegation(
        caller(main),
        plan('worker'),
        [],
        [],
        Array.from({ length: 5 }, (_, index) => ({ path: `${index}.md` }))
      )
    ).rejects.toThrow('2 MiB');
    expect((await service.getByTask(main.taskId))?.tasks.worker).toBeUndefined();
    await expect(
      service.registerDelegation(
        { ...caller(main), taskId: 'ordinary' },
        plan('worker'),
        [],
        [],
        [{ path: 'plan.md' }]
      )
    ).rejects.toThrow('responsible main');
  });
});

it('stores a selected document version once when implicit and explicit references resolve to it', async () => {
  const { deps } = setup();
  const read = vi.fn(async (record: Coordinator, path: string) => ({
    coordinatorId: record.id,
    path,
    revision: 'disk:1',
    content: 'Selected',
    workspaceId: 'documents',
  }));
  const service = new CoordinatorService({
    ...deps,
    documents: { read, describe: vi.fn(), create: vi.fn() },
  });
  const main = await service.ensureProject('project');
  await service.registerDelegation(
    caller(main),
    {
      id: 'worker',
      projectId: 'project',
      taskConfig: { version: '1', name: 'Worker' },
      workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    },
    [],
    [],
    [{ path: 'plan.md' }, { path: 'plan.md', revision: 'disk:1' }]
  );
  expect((await service.getTaskCoordination('worker'))?.assignment?.documents).toHaveLength(1);
  await expect(
    service.readDocument(main.id, 'plan.md', 'disk:1', caller(main, 'worker'))
  ).resolves.toMatchObject({ content: 'Selected' });
});

it('reads document location and creates a file without reactivating an initialized main workspace', async () => {
  const { deps, resources } = setup();
  const describe = vi.fn();
  const create = vi.fn();
  const service = new CoordinatorService({
    ...deps,
    documents: { describe, create, read: vi.fn() },
  });
  const main = await service.openProject('project');
  vi.mocked(resources.activate).mockClear();
  await service.documentWorkspace(main.id);
  await service.createDocument(main.id, 'plan.md');
  expect(describe).toHaveBeenCalledWith(main);
  expect(create).toHaveBeenCalledWith(main, 'plan.md');
  expect(resources.activate).not.toHaveBeenCalled();
  expect(resources.start).not.toHaveBeenCalled();
});

it('requires an initialized main workspace for commits without recursively allocating resources', async () => {
  const { deps, resources } = setup();
  const commit = vi.fn(async () => ({ hash: 'a'.repeat(40) }));
  const service = new CoordinatorService({
    ...deps,
    documents: { read: vi.fn(), create: vi.fn(), describe: vi.fn(), commit },
  });
  const record = await service.ensureProject('project');
  const input = { paths: ['plan.md'], message: 'Save plan', expectedRevision: 'b'.repeat(40) };
  await expect(service.commitDocuments(record.id, input)).rejects.toThrow('Open the main agent');
  expect(resources.prepare).not.toHaveBeenCalled();
  const opened = await service.open(record.id);
  vi.mocked(resources.activate).mockClear();
  await expect(service.commitDocuments(record.id, input)).resolves.toEqual({
    hash: 'a'.repeat(40),
  });
  expect(commit).toHaveBeenCalledWith(opened, input);
  expect(resources.activate).not.toHaveBeenCalled();
});

it('persists only an explicitly inspected document remote and rejects a changed selection before push preparation', async () => {
  const { deps, resources } = setup();
  const target = { remote: 'personal', destination: '/fork.git', fingerprint: 'a'.repeat(64) };
  const pushTarget = vi.fn(async () => target);
  const preparePush = vi.fn(async () => ({
    workspaceId: 'docs',
    remote: target.remote,
    expectedRemoteFingerprint: target.fingerprint,
    sourceRef: localBranchRefSchema.parse('refs/heads/emdash/manage/main'),
    targetRef: localBranchRefSchema.parse('refs/heads/emdash/manage/main'),
    oid: 'b'.repeat(40),
  }));
  const service = new CoordinatorService({
    ...deps,
    documents: { read: vi.fn(), describe: vi.fn(), create: vi.fn(), pushTarget, preparePush },
  });
  const main = await service.ensureProject('project');
  expect(main.documentPushTarget).toBeUndefined();
  await expect(
    service.configureDocumentPush(main.id, target.remote, 'c'.repeat(64))
  ).rejects.toThrow('changed');
  expect((await service.getByTask(main.taskId))?.documentPushTarget).toBeUndefined();
  await service.configureDocumentPush(main.id, target.remote, target.fingerprint);
  expect(preparePush).not.toHaveBeenCalled();
  const restored = new CoordinatorService(deps);
  expect((await restored.getByTask(main.taskId))?.documentPushTarget).toEqual(target);
  expect((await restored.getTaskCoordination(main.taskId))?.documentPushTarget).toEqual(target);
  expect(await restored.instructionsForTask(main.taskId)).toContain('/fork.git');
  await expect(
    service.prepareDocumentPush(main.id, 'b'.repeat(40), 'c'.repeat(64))
  ).rejects.toThrow('changed');
  expect(preparePush).not.toHaveBeenCalled();
  await service.prepareDocumentPush(main.id, 'b'.repeat(40), target.fingerprint);
  expect(preparePush).toHaveBeenCalledOnce();
  await service.configureDocumentPush(main.id, null);
  expect((await restored.getByTask(main.taskId))?.documentPushTarget).toBeUndefined();
  expect(resources.start).not.toHaveBeenCalled();
  expect(resources.prepare).not.toHaveBeenCalled();
});

describe('document migration recovery', () => {
  async function migrationSetup() {
    const test = setup();
    const main = await test.service.openProject('project');
    const saved = test.records.get(main.id);
    if (!saved?.params) throw new Error('Missing source runtime');
    saved.params.workspaceConfig.git = {
      kind: 'create-branch',
      branchName: 'legacy-main',
      fromBranch: { type: 'local', branch: 'main' },
    };
    test.records.set(saved.id, saved);
    await test.service.registerDelegation(caller(main), {
      id: 'worker-task',
      projectId: 'project',
      taskConfig: { version: '1', name: 'Worker' },
      workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
    });
    const original = structuredClone(test.records.get(main.id));
    const sourceFiles = new Map([
      ['plans/decision.md', 'selected decision'],
      ['notes/result.md', 'selected result'],
      ['README.md', 'product docs stay with code'],
    ]);
    const copiedFiles = new Map<string, string>();
    const snapshot = (taskId: string, path: string, content: string): ManagementDocument => ({
      coordinatorId: main.id,
      workspaceId: `workspace:${taskId}`,
      path,
      content,
      revision: `disk:${createHash('sha256').update(content).digest('hex')}`,
    });
    const documents = {
      describe: vi.fn(),
      create: vi.fn(),
      read: vi.fn(async (record: Coordinator, path: string, revision?: string) => {
        const taskId = record.documentStorage?.taskId;
        if (!taskId) throw new Error('Missing target binding');
        const content = copiedFiles.get(`${taskId}/${path}`);
        if (content === undefined) throw new Error('Missing copied document');
        const result = snapshot(taskId, path, content);
        if (revision && revision !== result.revision) throw new Error('Destination changed');
        return result;
      }),
      readMigrationSource: vi.fn(
        async (_record: Coordinator, source: DocumentStorage, path: string) => {
          const content =
            source.taskId === main.taskId
              ? sourceFiles.get(path)
              : copiedFiles.get(`${source.taskId}/${path}`);
          if (content === undefined) throw new Error('Missing source document');
          return snapshot(source.taskId, path, content);
        }
      ),
      copyMigrationDocument: vi.fn(
        async (_record: Coordinator, target: DocumentStorage, file: ManagementDocument) => {
          const key = `${target.taskId}/${file.path}`;
          if (copiedFiles.has(key) && copiedFiles.get(key) !== file.content)
            throw new Error('Destination changed');
          copiedFiles.set(key, file.content);
          return snapshot(target.taskId, file.path, file.content);
        }
      ),
    };
    vi.mocked(test.resources.prepare).mockImplementation(async (_caller, request, ids) => ({
      id: ids.taskId,
      projectId: request.projectId!,
      taskConfig: { version: '1', name: request.name },
      workspaceConfig: {
        version: '2',
        git: { kind: 'management', branchName: `emdash/manage/${ids.taskId}` },
        workspace: { kind: 'new-worktree' },
      },
    }));
    const service = () => new CoordinatorService({ ...test.deps, documents });
    const input = {
      requestId: randomUUID(),
      projectId: 'target',
      paths: ['plans/decision.md', 'notes/result.md'],
    };
    return { ...test, main, original, sourceFiles, copiedFiles, documents, service, input };
  }

  it('records a root filename without treating it as an object property', async () => {
    const test = await migrationSetup();
    test.sourceFiles.set('__proto__', 'plain document');
    const prepared = await test
      .service()
      .prepareDocumentMigration(test.main.id, { ...test.input, paths: ['__proto__'] });
    if (!prepared.documentMigration) throw new Error('Missing migration');
    const completed = await test
      .service()
      .runDocumentMigration(test.main.id, prepared.documentMigration.id);
    expect(completed.documentMigration?.copied).toEqual([
      { path: '__proto__', revision: expect.stringMatching(/^disk:/) },
    ]);
    expect((await test.service().getByTask(test.main.taskId))?.documentMigration?.phase).toBe(
      'complete'
    );
    expect(test.sourceFiles.get('__proto__')).toBe('plain document');
  });

  it('exposes active and pending storage references but releases the source reference after a verified move', async () => {
    const test = await migrationSetup();
    const service = test.service();
    const prepared = await service.prepareDocumentMigration(test.main.id, test.input);
    if (!prepared.documentMigration) throw new Error('Missing migration');
    expect(await service.documentStorageReferences('target')).toHaveLength(1);
    expect(await service.documentStorageReferences('project')).toHaveLength(1);
    const completed = await service.runDocumentMigration(
      test.main.id,
      prepared.documentMigration.id
    );
    expect(await service.documentStorageReferences('target')).toHaveLength(1);
    expect(await service.documentStorageReferences('project')).toHaveLength(0);
    const next = await service.prepareDocumentMigration(test.main.id, {
      ...test.input,
      requestId: randomUUID(),
      projectId: 'another-target',
    });
    if (!next.documentMigration) throw new Error('Missing migration');
    expect(await service.documentStorageReferences('another-target')).toHaveLength(1);
    await service.cancelDocumentMigration(test.main.id, next.documentMigration.id);
    expect(await service.documentStorageReferences('another-target')).toHaveLength(0);
    expect((await service.getByTask(test.main.taskId))?.documentStorage?.taskId).toBe(
      completed.documentStorage?.taskId
    );
  });

  it.each(['copy', 'verified', 'publish'] as const)(
    'resumes after a failure at %s without replacing source identity or allocating another destination',
    async (fault) => {
      const test = await migrationSetup();
      const service = test.service();
      const prepared = await service.prepareDocumentMigration(test.main.id, test.input);
      const migration = prepared.documentMigration;
      if (!migration) throw new Error('Missing migration');
      expect(test.resources.create).toHaveBeenCalledOnce();
      const repeated = await service.prepareDocumentMigration(test.main.id, {
        ...test.input,
        paths: [...test.input.paths].reverse(),
      });
      expect(repeated.documentMigration?.target.taskId).toBe(migration.target.taskId);
      await expect(
        service.prepareDocumentMigration(test.main.id, { ...test.input, paths: ['README.md'] })
      ).rejects.toThrow('different parameters');
      let injected = false;
      if (fault === 'copy') {
        const copy = test.documents.copyMigrationDocument.getMockImplementation();
        if (!copy) throw new Error('Missing copy operation');
        test.documents.copyMigrationDocument.mockImplementation(async (...args) => {
          if (!injected && test.copiedFiles.size === 1) {
            injected = true;
            throw new Error('Injected interruption');
          }
          return copy(...args);
        });
      } else {
        const save = test.deps.store.setOrThrow;
        vi.spyOn(test.deps.store, 'setOrThrow').mockImplementation(async (id, record) => {
          if (
            !injected &&
            record.documentMigration?.phase === (fault === 'verified' ? 'verified' : 'complete')
          ) {
            injected = true;
            throw new Error('Injected interruption');
          }
          await save(id, record);
        });
      }
      await expect(service.runDocumentMigration(test.main.id, migration.id)).rejects.toThrow(
        'Injected interruption'
      );
      const interrupted = test.records.get(test.main.id);
      expect(interrupted?.documentStorage).toBeUndefined();
      expect(interrupted?.params).toEqual(test.original?.params);
      expect(interrupted?.conversationId).toBe(test.original?.conversationId);
      expect(interrupted?.tasks).toEqual(test.original?.tasks);
      expect(interrupted?.documentMigration?.error).toContain('Injected interruption');
      const resumed = await test.service().runDocumentMigration(test.main.id, migration.id);
      expect(resumed.documentMigration?.phase).toBe('complete');
      expect(resumed.documentStorage?.taskId).toBe(migration.target.taskId);
      expect(resumed.documentStorageHistory?.[0].params).toEqual(test.original?.params);
      expect(resumed.params).toEqual(test.original?.params);
      expect(resumed.tasks).toEqual(test.original?.tasks);
      expect(resumed.taskId).toBe(test.main.taskId);
      expect(resumed.conversationId).toBe(test.main.conversationId);
      expect(test.resources.create).toHaveBeenCalledTimes(2);
      expect(test.resources.prepare).toHaveBeenCalledTimes(2);
      expect(test.resources.start).not.toHaveBeenCalled();
      expect(test.sourceFiles.get('README.md')).toBe('product docs stay with code');
      expect([...test.copiedFiles.keys()].some((path) => path.endsWith('/README.md'))).toBe(false);
      await test.service().runDocumentMigration(test.main.id, migration.id);
      expect(test.resources.create).toHaveBeenCalledTimes(2);
    }
  );

  it('rejects source changes, permits cancelling the plan and freezes fresh versions for another migration', async () => {
    const test = await migrationSetup();
    const prepared = await test.service().prepareDocumentMigration(test.main.id, test.input);
    const migration = prepared.documentMigration;
    if (!migration) throw new Error('Missing migration');
    test.sourceFiles.set('plans/decision.md', 'edited after preparation');
    await expect(test.service().runDocumentMigration(test.main.id, migration.id)).rejects.toThrow(
      'Source document changed'
    );
    expect(test.resources.create).toHaveBeenCalledOnce();
    await expect(
      test.service().cancelDocumentMigration(test.main.id, 'superseded')
    ).rejects.toThrow('changed');
    const cancelled = await test.service().cancelDocumentMigration(test.main.id, migration.id);
    expect(cancelled.documentStorage).toBeUndefined();
    expect(cancelled.documentMigration?.phase).toBe('cancelled');
    const next = await test
      .service()
      .prepareDocumentMigration(test.main.id, { ...test.input, requestId: randomUUID() });
    if (!next.documentMigration) throw new Error('Missing replacement plan');
    expect(next.documentMigration.target.taskId).not.toBe(migration.target.taskId);
    expect(
      next.documentMigration.files.find((file) => file.path === 'plans/decision.md')?.content
    ).toBe('edited after preparation');
    await test.service().runDocumentMigration(test.main.id, next.documentMigration.id);
    expect(test.sourceFiles.get('plans/decision.md')).toBe('edited after preparation');
  });
});
