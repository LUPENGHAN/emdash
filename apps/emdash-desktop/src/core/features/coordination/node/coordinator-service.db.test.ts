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
      getConversation: async (id) =>
        id === 'replacement-main'
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
  await restarted.bindConversation(record.id, 'replacement-main');
  const switched = await service().getByTask(record.taskId);
  expect(switched?.conversationId).toBe('replacement-main');
  expect(switched?.tasks.worker.result?.summary).toBe('Implemented');
  expect(switched?.events[0].state).toBe('acknowledged');
});
