import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import { freezeDelegationSelection } from './selection-snapshot';
import {
  TaskDelegationService,
  type DelegationRecord,
  type TaskDelegationDependencies,
} from './task-delegation-service';

const caller = {
  conversationId: 'caller',
  taskId: 'source-task',
  projectId: 'project',
  providerId: 'claude',
  title: 'Main',
  cwd: '/source',
};
const request = {
  kind: 'create_task' as const,
  name: 'Implement',
  prompt: 'Fix and verify',
  requestId: 'request',
};
function setup() {
  const records = new Map<string, DelegationRecord>();
  const tasks = new Map<string, 'available' | 'deleted'>();
  const sessions = new Set<string>();
  const deps: TaskDelegationDependencies = {
    store: {
      getOrThrow: async (id) => records.get(id) ?? null,
      setOrThrow: async (id, value) => {
        records.set(id, structuredClone(value));
      },
      getAll: async () => Object.fromEntries(records),
    },
    authorize: vi.fn(async () => {}),
    prepare: vi.fn(
      async (_caller, action, ids): Promise<CreateTaskParams> => ({
        id: ids.taskId,
        projectId: action.projectId!,
        taskConfig: {
          version: '1',
          name: action.name,
          ...(action.prompt && {
            initialConversation: {
              id: ids.conversationId,
              provider: 'claude',
              type: 'pty',
              initialPrompt: action.prompt,
              effort: 'high',
            },
          }),
        },
        workspaceConfig: {
          version: '2',
          git: {
            kind: 'create-branch',
            branchName: 'implement',
            fromBranch: { type: 'local', branch: 'baseline' },
          },
          workspace: { kind: 'new-worktree' },
        },
      })
    ),
    findTask: async (id) => tasks.get(id) ?? 'missing',
    create: vi.fn(async (params) => {
      tasks.set(params.id, 'available');
    }),
    activate: vi.fn(async () => ({ path: '/worktree' })),
    start: vi.fn(async (params) => {
      sessions.add(params.taskConfig.initialConversation!.id);
    }),
  };
  return { records, tasks, sessions, deps, service: new TaskDelegationService(deps) };
}

describe('durable task delegation', () => {
  it('rejects changed execution values or provenance after a frozen selection was saved', async () => {
    const t = setup();
    const prepare = vi.mocked(t.deps.prepare).getMockImplementation()!;
    vi.mocked(t.deps.prepare).mockImplementation(async (...args) => {
      const params = await prepare(...args);
      const initial = params.taskConfig.initialConversation!;
      return {
        ...params,
        selectionSnapshot: freezeDelegationSelection(initial, request, undefined, {
          effort: 'high',
        }),
      };
    });
    const result = JSON.parse((await t.service.dispatch(caller, request)).text);
    const [key, saved] = [...t.records.entries()][0];
    expect((await t.service.status(result.task_id))?.selectionSnapshot).toEqual(
      result.selection_snapshot
    );
    const changed = structuredClone(saved);
    changed.params.taskConfig.initialConversation!.effort = 'low';
    t.records.set(key, changed);
    await expect(t.service.status(result.task_id)).rejects.toThrow('Cannot read delegation record');
    const sourceChanged = structuredClone(saved);
    sourceChanged.params.selectionSnapshot!.sources.effort = 'request';
    t.records.set(key, sourceChanged);
    await expect(t.service.dispatch(caller, request)).rejects.toThrow(
      'Cannot read delegation record'
    );
    expect(t.deps.create).toHaveBeenCalledOnce();
    expect(t.deps.start).toHaveBeenCalledOnce();
    const future = structuredClone(saved);
    Reflect.set(future.params.selectionSnapshot!, 'version', '99');
    t.records.set(key, future);
    await expect(t.service.status(result.task_id)).rejects.toThrow('Cannot read delegation record');
  });
  it('retries a failed startup by task ID under its current owner without re-preparing inputs', async () => {
    const test = setup();
    const changed = vi.fn();
    test.deps.onStateChange = changed;
    vi.mocked(test.deps.start).mockRejectedValueOnce(new Error('Agent installation unavailable'));
    await expect(test.service.dispatch(caller, request)).rejects.toThrow(
      'installation unavailable'
    );
    const saved = structuredClone([...test.records.values()][0]);
    const taskId = saved.params.id;
    expect(await test.service.status(taskId)).toMatchObject({
      phase: 'starting',
      error: 'Agent installation unavailable',
      canRetry: true,
    });
    const receiver = {
      ...caller,
      conversationId: 'replacement-conversation',
      taskId: 'replacement-main',
      providerId: 'opencode',
    };
    test.deps.recoveryContext = async () => ({ caller: receiver, projectGrants: ['permitted'] });
    const recovered = new TaskDelegationService(test.deps);
    await expect(recovered.retry(caller, taskId)).rejects.toThrow(
      'responsible main task workspace'
    );
    expect(test.deps.start).toHaveBeenCalledOnce();
    const [first, repeated] = await Promise.all([
      recovered.retry(receiver, taskId),
      recovered.retry(receiver, taskId),
    ]);
    expect(repeated).toEqual(first);
    expect(JSON.parse(first.text)).toMatchObject({
      task_id: taskId,
      conversation_id: saved.params.taskConfig.initialConversation?.id,
      configuration: saved.params.taskConfig.initialConversation,
      request_id: saved.request.requestId,
      status: 'agent_started',
    });
    expect(test.deps.prepare).toHaveBeenCalledOnce();
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledTimes(2);
    expect(test.deps.authorize).toHaveBeenLastCalledWith(
      receiver,
      saved.params.projectId,
      expect.objectContaining({ projectGrants: ['permitted'] })
    );
    const stored = [...test.records.values()][0];
    expect(stored.params).toEqual(saved.params);
    expect(stored.fingerprint).toBe(saved.fingerprint);
    expect(stored.request).toEqual(saved.request);
    expect(await recovered.status(taskId)).toEqual({
      taskId,
      phase: 'started',
      conversationId: saved.params.taskConfig.initialConversation?.id,
      path: '/worktree',
      error: undefined,
      waitReason: undefined,
      canRetry: false,
    });
    expect(changed).toHaveBeenCalledWith(taskId);
  });

  it('keeps failed delegations explicit and refuses deleted, unavailable or ambiguous retry targets', async () => {
    const test = setup();
    vi.mocked(test.deps.activate).mockRejectedValueOnce(new Error('Host disconnected'));
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('Host disconnected');
    const [key, saved] = [...test.records][0];
    await test.service.resumePending(() => {});
    expect(test.deps.activate).toHaveBeenCalledOnce();
    await expect(test.service.retry(caller, 'missing')).rejects.toThrow('no saved delegation');
    expect(await test.service.status('missing')).toBeNull();
    test.tasks.set(saved.params.id, 'deleted');
    await expect(test.service.retry(caller, saved.params.id)).rejects.toThrow('deleted');
    test.records.set('duplicate', saved);
    await expect(test.service.retry(caller, saved.params.id)).rejects.toThrow('multiple');
    test.records.delete('duplicate');
    test.records.set(key, { ...saved, version: '100' } as unknown as DelegationRecord);
    await expect(test.service.retry(caller, saved.params.id)).rejects.toThrow('Cannot read');
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).not.toHaveBeenCalled();
  });

  it('creates, activates and starts without any renderer, deduplicating concurrent requests', async () => {
    const test = setup();
    const [first, second] = await Promise.all([
      test.service.dispatch(caller, request),
      test.service.dispatch(caller, request),
    ]);
    expect(JSON.parse(first.text)).toMatchObject({
      status: 'agent_started',
      path: '/worktree',
      request_id: 'request',
    });
    expect(second).toEqual(first);
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledOnce();
    expect(test.tasks.size).toBe(1);
  });

  it('retains request fingerprints without grants and includes explicit grants in retry identity', async () => {
    const test = setup();
    await test.service.dispatch(caller, request);
    const saved = [...test.records.values()][0];
    const historical = createHash('sha256')
      .update(
        JSON.stringify([
          caller.projectId,
          request.name,
          undefined,
          request.prompt,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ])
      )
      .digest('hex');
    expect(saved.fingerprint).toBe(historical);
    await expect(
      test.service.dispatch(caller, { ...request, projectGrants: ['other'] })
    ).rejects.toThrow('different task parameters');
    const granted = { ...request, requestId: 'granted', projectGrants: ['b', 'a'] };
    const first = await test.service.dispatch(caller, granted);
    expect(
      await test.service.dispatch(caller, { ...granted, projectGrants: ['a', 'b', 'a'] })
    ).toEqual(first);
  });

  it('returns persisted task IDs after service recreation and freezes initial configuration', async () => {
    const test = setup();
    const first = await test.service.dispatch(caller, request);
    const restarted = new TaskDelegationService(test.deps);
    expect(await restarted.dispatch(caller, request)).toEqual(first);
    expect(test.deps.prepare).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledOnce();
    expect(JSON.parse(first.text).configuration.effort).toBe('high');
  });

  it('rejects request ID reuse with changed parameters before changing resources', async () => {
    const test = setup();
    await test.service.dispatch(caller, request);
    await expect(test.service.dispatch(caller, { ...request, model: 'another' })).rejects.toThrow(
      'different task parameters'
    );
    expect(test.deps.create).toHaveBeenCalledOnce();
  });

  it('recovers an interruption after task creation without creating another task', async () => {
    const test = setup();
    vi.mocked(test.deps.create).mockImplementationOnce(async (params) => {
      test.tasks.set(params.id, 'available');
      throw new Error('Connection lost after commit');
    });
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('Connection lost');
    await new TaskDelegationService(test.deps).dispatch(caller, request);
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledOnce();
  });

  it('retries activation using the same branch and frozen initial conversation', async () => {
    const test = setup();
    vi.mocked(test.deps.activate).mockRejectedValueOnce(new Error('Host disconnected'));
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('Host disconnected');
    const initial = [...test.records.values()][0].params;
    const result = await new TaskDelegationService(test.deps).dispatch(caller, request);
    expect(JSON.parse(result.text).task_id).toBe(initial.id);
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledWith(initial);
  });

  it('uses idempotent runtime attachment after an interrupted startup', async () => {
    const test = setup();
    vi.mocked(test.deps.start).mockImplementationOnce(async (params) => {
      test.sessions.add(params.taskConfig.initialConversation!.id);
      throw new Error('Lost startup acknowledgment');
    });
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('acknowledgment');
    await new TaskDelegationService(test.deps).dispatch(caller, request);
    expect(test.sessions.size).toBe(1);
    expect(test.deps.create).toHaveBeenCalledOnce();
  });

  it('does not recreate a deleted or archived task on retry', async () => {
    const test = setup();
    const first = JSON.parse((await test.service.dispatch(caller, request)).text);
    test.tasks.set(first.task_id, 'deleted');
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('was deleted');
    expect(test.deps.create).toHaveBeenCalledOnce();
  });

  it('does not create or start anything when authorization or preparation fails', async () => {
    const test = setup();
    vi.mocked(test.deps.authorize).mockRejectedValueOnce(new Error('Denied'));
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('Denied');
    vi.mocked(test.deps.prepare).mockRejectedValueOnce(new Error('Invalid model'));
    await expect(test.service.dispatch(caller, request)).rejects.toThrow('Invalid model');
    expect(test.records.size).toBe(0);
    expect(test.deps.create).not.toHaveBeenCalled();
  });

  it('prepares a worktree-only task without claiming an agent started', async () => {
    const test = setup();
    const result = JSON.parse(
      (await test.service.dispatch(caller, { ...request, prompt: undefined })).text
    );
    expect(result.status).toBe('workspace_ready');
    expect(result.conversation_id).toBeUndefined();
    expect(test.deps.start).not.toHaveBeenCalled();
  });

  it('recovers only interrupted non-failed requests automatically', async () => {
    const test = setup();
    await test.service.dispatch(caller, request);
    const [id, record] = [...test.records.entries()][0];
    test.records.set(id, { ...record, phase: 'created' });
    const errors = vi.fn();
    await new TaskDelegationService(test.deps).resumePending(errors);
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    test.records.set(id, { ...record, phase: 'starting', error: 'Needs configuration' });
    await new TaskDelegationService(test.deps).resumePending(errors);
    expect(test.deps.start).toHaveBeenCalledTimes(2);
  });

  it('reports a malformed persisted entry and still recovers another pending request', async () => {
    const test = setup();
    await test.service.dispatch(caller, request);
    const [key, record] = [...test.records.entries()][0];
    test.records.clear();
    test.records.set('malformed', { ...record, phase: 'invalid' } as unknown as DelegationRecord);
    test.records.set(key, { ...record, phase: 'created' });
    const report = vi.fn();
    await new TaskDelegationService(test.deps).resumePending(report);
    expect(report).toHaveBeenCalledOnce();
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledTimes(2);
  });
});

describe('waiting delegation recovery', () => {
  it('persists planned IDs without resources and starts once after the prerequisite is accepted', async () => {
    const test = setup();
    let waiting = true;
    test.deps.getBlocker = vi.fn(async () => (waiting ? 'Waiting for review' : null));
    test.deps.onCreated = vi.fn(async () => {});
    const action = { ...request, dependsOn: ['a', 'b'] };
    const planned = JSON.parse((await test.service.dispatch(caller, action)).text);
    expect(planned).toMatchObject({
      status: 'blocked',
      planned_branch: 'implement',
      waiting_for: 'Waiting for review',
    });
    expect(planned.path).toBeUndefined();
    expect(test.deps.create).not.toHaveBeenCalled();
    expect(test.deps.activate).not.toHaveBeenCalled();
    expect(test.deps.start).not.toHaveBeenCalled();
    const restarted = new TaskDelegationService(test.deps);
    const report = vi.fn();
    await restarted.resumePending(report);
    expect(test.deps.start).not.toHaveBeenCalled();
    expect(
      JSON.parse((await restarted.dispatch(caller, { ...action, dependsOn: ['b', 'a', 'a'] })).text)
        .task_id
    ).toBe(planned.task_id);
    await expect(restarted.dispatch(caller, { ...action, dependsOn: ['a'] })).rejects.toThrow(
      'different task parameters'
    );
    waiting = false;
    await Promise.all([restarted.resumePending(report), restarted.resumePending(report)]);
    const running = JSON.parse((await restarted.dispatch(caller, action)).text);
    expect(running).toMatchObject({
      task_id: planned.task_id,
      conversation_id: planned.conversation_id,
      status: 'agent_started',
      configuration: { effort: 'high' },
    });
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledOnce();
    expect(test.deps.prepare).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });
  it('resumes with the current owner without rekeying the request or changing its frozen configuration', async () => {
    const test = setup();
    let waiting = true;
    test.deps.getBlocker = async () => (waiting ? 'Waiting' : null);
    const first = JSON.parse(
      (await test.service.dispatch(caller, { ...request, dependsOn: ['a'] })).text
    );
    const originalKeys = [...test.records.keys()];
    const current = { ...caller, taskId: 'other-main', conversationId: 'replacement-main' };
    test.deps.recoveryContext = async () => ({ caller: current, projectGrants: [] });
    test.deps.onPrepared = vi.fn(async () => {});
    waiting = false;
    const report = vi.fn();
    await new TaskDelegationService(test.deps).resumePending(report);
    expect(test.deps.authorize).toHaveBeenLastCalledWith(
      current,
      'project',
      expect.objectContaining({ dependsOn: ['a'] })
    );
    expect(test.deps.onPrepared).toHaveBeenCalledWith(
      current,
      expect.objectContaining({ id: first.task_id }),
      expect.anything()
    );
    expect([...test.records.keys()]).toEqual(originalKeys);
    expect([...test.records.values()][0].caller).toEqual(caller);
    expect(test.deps.prepare).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });
  it('rejects future delegation versions before resources can be replayed', async () => {
    const test = setup();
    await test.service.dispatch(caller, request);
    const [key, value] = [...test.records.entries()][0];
    test.records.set(key, {
      ...value,
      version: '99',
      phase: 'prepared',
    } as unknown as DelegationRecord);
    const report = vi.fn();
    await new TaskDelegationService(test.deps).resumePending(report);
    expect(report).toHaveBeenCalledOnce();
    expect(test.deps.create).toHaveBeenCalledOnce();
    expect(test.deps.start).toHaveBeenCalledOnce();
  });
});

it('includes document references and versions in retry identity while preserving an empty reference list', async () => {
  const { service, deps } = setup();
  await service.dispatch(caller, request);
  await expect(service.dispatch(caller, { ...request, documentRefs: [] })).resolves.toBeDefined();
  await expect(
    service.dispatch(caller, { ...request, documentRefs: [{ path: 'plan.md' }] })
  ).rejects.toThrow('different task parameters');
  const selected = {
    ...request,
    requestId: 'with-documents',
    documentRefs: [{ coordinatorId: 'source', path: 'plan.md', revision: 'disk:1' }],
  };
  await service.dispatch(caller, selected);
  await expect(
    service.dispatch(caller, {
      ...selected,
      documentRefs: [{ ...selected.documentRefs[0], revision: 'disk:2' }],
    })
  ).rejects.toThrow('different task parameters');
  expect(deps.create).toHaveBeenCalledTimes(2);
});
