import { describe, expect, it, vi } from 'vitest';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
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
