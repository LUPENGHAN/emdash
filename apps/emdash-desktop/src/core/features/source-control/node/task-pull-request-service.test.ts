import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCaller } from '@core/features/agent-control/api';
import type {
  TaskPullRequestInput,
  TaskPullRequestPlan,
  TaskPullRequestRecord,
} from '../api/task-pull-requests';
import {
  TaskPullRequestService,
  type TaskPullRequestDependencies,
} from './task-pull-request-service';

function setup() {
  const records = new Map<string, TaskPullRequestRecord>();
  const input: TaskPullRequestInput = {
    taskId: 'worker',
    requestId: 'pr-1',
    title: 'Implement',
    draft: false,
  };
  const plan: TaskPullRequestPlan = {
    taskId: 'worker',
    projectId: 'sdk',
    workspaceId: 'worktree',
    sourceRef: localBranchRefSchema.parse('refs/heads/feat/sdk'),
    oid: 'a'.repeat(40),
    pushTarget: {
      remote: 'personal',
      destination: 'https://github.com/me/sdk',
      fingerprint: 'b'.repeat(64),
    },
    repositoryUrl: 'https://github.com/org/sdk',
    headRepositoryUrl: 'https://github.com/me/sdk',
    base: 'develop',
    title: input.title,
    draft: false,
  };
  const caller: AgentCaller = {
    taskId: 'main',
    projectId: 'coordination',
    conversationId: 'main-session',
    providerId: 'opencode',
    title: 'Main',
    cwd: null,
  };
  let owner = caller.taskId;
  const deps: TaskPullRequestDependencies = {
    store: {
      getOrThrow: async (key) => structuredClone(records.get(key) ?? null),
      getAll: async () => structuredClone(Object.fromEntries(records)),
      setOrThrow: vi.fn(async (key, value) => {
        records.set(key, structuredClone(value));
      }),
    },
    authorize: vi.fn(async (_taskId, source) => {
      if (source && source.taskId !== owner && source.taskId !== input.taskId)
        throw new Error('Owner changed');
    }),
    prepare: vi.fn(async () => structuredClone(plan)),
    check: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    ensure: vi.fn(async () => ({ url: `${plan.repositoryUrl}/pull/7`, number: 7 })),
    associate: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  return {
    input,
    plan,
    caller,
    records,
    deps,
    service: () => new TaskPullRequestService(deps),
    owner: (taskId: string) => {
      owner = taskId;
    },
  };
}

describe('durable task PR requests', () => {
  it('persists a preview before network writes and freezes resolved defaults across recreation', async () => {
    const t = setup();
    const prepared = await t.service().prepare(t.input, t.caller);
    expect(prepared).toMatchObject({ phase: 'prepared', plan: t.plan });
    expect(t.deps.push).not.toHaveBeenCalled();
    expect(t.deps.ensure).not.toHaveBeenCalled();
    vi.mocked(t.deps.prepare).mockRejectedValue(new Error('Defaults changed'));
    expect(await t.service().prepare(t.input, t.caller)).toEqual(prepared);
    const result = await t.service().run(t.input.taskId, t.input.requestId, t.caller);
    expect(result.phase).toBe('complete');
    expect(result.plan).toEqual(prepared.plan);
    expect(t.deps.prepare).toHaveBeenCalledOnce();
    expect(await t.service().create(t.input, t.caller)).toEqual(result);
    expect(t.deps.push).toHaveBeenCalledOnce();
    expect(t.deps.ensure).toHaveBeenCalledOnce();
  });
  it('rejects reused IDs with changed targets or content without resolving or pushing again', async () => {
    const t = setup();
    await t.service().prepare(t.input, t.caller);
    await expect(t.service().prepare({ ...t.input, base: 'main' }, t.caller)).rejects.toThrow(
      'different parameters'
    );
    expect(t.deps.prepare).toHaveBeenCalledOnce();
    expect(t.deps.push).not.toHaveBeenCalled();
  });
  it.each(['pushing', 'pushed', 'creating', 'receipt', 'complete'] as const)(
    'recovers a persistence failure at %s from the last durable step',
    async (phase) => {
      const t = setup();
      const service = t.service();
      await service.prepare(t.input, t.caller);
      const write = t.deps.store.setOrThrow;
      let failed = false;
      vi.mocked(write).mockImplementation(async (key, record) => {
        const matches =
          phase === 'receipt'
            ? record.phase === 'creating' && !!record.result
            : record.phase === phase;
        if (matches && !failed) {
          failed = true;
          throw new Error('Injected crash');
        }
        t.records.set(key, structuredClone(record));
      });
      await expect(service.run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
        'Injected crash'
      );
      const durable = [...t.records.values()][0];
      expect(durable?.phase).not.toBe('complete');
      expect(durable?.error).toContain('Injected crash');
      const recovered = await t.service().run(t.input.taskId, t.input.requestId, t.caller);
      expect(recovered).toMatchObject({ phase: 'complete', plan: t.plan, result: { number: 7 } });
      expect(t.deps.prepare).toHaveBeenCalledOnce();
      // Re-pushing the same fixed OID is allowed when its receipt was not durable.
      expect(vi.mocked(t.deps.push).mock.calls.length).toBe(phase === 'pushed' ? 2 : 1);
      // A lost creation receipt invokes ensure, whose platform lookup recovers the same PR.
      expect(vi.mocked(t.deps.ensure).mock.calls.length).toBe(phase === 'receipt' ? 2 : 1);
    }
  );
  it('exposes a lost platform response and retries creation without repeating a completed push', async () => {
    const t = setup();
    vi.mocked(t.deps.ensure).mockRejectedValueOnce(new Error('Response lost'));
    await expect(t.service().create(t.input, t.caller)).rejects.toThrow('Response lost');
    expect((await t.service().list(t.input.taskId, t.caller))[0]).toMatchObject({
      phase: 'creating',
      error: expect.stringContaining('Response lost'),
    });
    const result = await t.service().run(t.input.taskId, t.input.requestId, t.caller);
    expect(result.phase).toBe('complete');
    expect(t.deps.push).toHaveBeenCalledOnce();
  });
  it('allows the current owner to resume and refuses the former owner after takeover', async () => {
    const t = setup();
    vi.mocked(t.deps.push).mockImplementationOnce(async () => {
      t.owner('replacement');
    });
    await expect(t.service().create(t.input, t.caller)).rejects.toThrow('Owner changed');
    expect(t.deps.ensure).not.toHaveBeenCalled();
    const current = { ...t.caller, taskId: 'replacement', conversationId: 'replacement-session' };
    const result = await t.service().run(t.input.taskId, t.input.requestId, current);
    expect(result.phase).toBe('complete');
    expect(t.deps.push).toHaveBeenCalledOnce();
    await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
      'Owner changed'
    );
  });
  it('stops before publishing if the pinned branch or remote changed', async () => {
    const t = setup();
    await t.service().prepare(t.input, t.caller);
    vi.mocked(t.deps.check).mockRejectedValue(new Error('Source changed'));
    await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
      'Source changed'
    );
    expect(t.deps.push).not.toHaveBeenCalled();
    expect(t.deps.ensure).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent requests within one process', async () => {
    const t = setup();
    const service = t.service();
    const [first, second] = await Promise.all([
      service.create(t.input, t.caller),
      service.create(t.input, t.caller),
    ]);
    expect(first).toEqual(second);
    expect(t.deps.push).toHaveBeenCalledOnce();
    expect(t.deps.ensure).toHaveBeenCalledOnce();
  });
  it('refuses unknown record versions rather than preparing or overwriting them', async () => {
    const t = setup();
    await t.service().prepare(t.input, t.caller);
    const [key, record] = [...t.records.entries()][0]!;
    t.records.set(key, { ...record, version: '99' } as unknown as TaskPullRequestRecord);
    await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
      'Cannot read'
    );
    expect(t.records.get(key)?.version).toBe('99');
    expect(t.deps.push).not.toHaveBeenCalled();
  });
  it('does not treat a completed record without a receipt as a successful PR', async () => {
    const t = setup();
    await t.service().prepare(t.input, t.caller);
    const entry = [...t.records.entries()][0];
    if (!entry) throw new Error('Missing prepared request');
    t.records.set(entry[0], { ...entry[1], phase: 'complete' });
    await expect(t.service().run(t.input.taskId, t.input.requestId, t.caller)).rejects.toThrow(
      'no saved receipt'
    );
    expect(t.deps.push).not.toHaveBeenCalled();
    expect(t.deps.ensure).not.toHaveBeenCalled();
  });
});
