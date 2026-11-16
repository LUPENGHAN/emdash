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
  const service = () =>
    new CoordinatorService({
      store: new AppDbKeyValueStore<Record<string, Coordinator>>(fixture.db, 'coordinators'),
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
  await first.update(record.id, { delegationDefaults: { agent: 'codex', effort: 'high' } });
  await first.registerDelegation(main, {
    id: 'worker',
    projectId: record.projectId,
    taskConfig: { version: '1', name: 'Code task' },
    workspaceConfig: { version: '2', git: { kind: 'none' }, workspace: { kind: 'new-worktree' } },
  });
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
});
