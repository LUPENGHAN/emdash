import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createConversationRegistry,
  conversationRegistryTable,
} from '@core/features/conversations/api/node/registry';
import { tasks } from '@core/services/app-db/node/schema';
import { resolveAgentCaller } from './resolve-caller';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let taskId: string;
beforeEach(async () => {
  fixture = await openFixture('baseline');
  const [task] = await fixture.db.select().from(tasks).limit(1);
  taskId = task.id;
  const registry = createConversationRegistry(fixture.db);
  registry.adopt({
    id: 'caller',
    title: 'Worker',
    provider: 'claude',
    type: 'acp',
    location: 'local',
    workspacePath: '/temporary/task',
    lastObservedAt: '2026-01-01T00:00:00.000Z',
    observedStatus: 'present',
  });
  registry.annotate('caller', { projectId: task.projectId, taskId });
});
afterEach(() => {
  fixture.close();
});
const resolve = () => resolveAgentCaller(fixture.db, async () => '/temporary/task', 'caller');

it('resolves an active task-linked caller', async () => {
  expect(await resolve()).toMatchObject({ conversationId: 'caller', taskId, providerId: 'claude' });
});

it.each(['deletedAt', 'archivedAt'] as const)('rejects a task with %s', async (field) => {
  await fixture.db
    .update(tasks)
    .set({ [field]: '2026-01-02T00:00:00.000Z' })
    .where(eq(tasks.id, taskId));
  expect(await resolve()).toBeNull();
});

it('rejects a conversation with a pending removal before its row is purged', async () => {
  await fixture.db
    .update(conversationRegistryTable)
    .set({
      deletionTombstone: {
        version: '1',
        targetRecordId: 'host-record',
        tombstonedAt: 1,
      },
    })
    .where(eq(conversationRegistryTable.id, 'caller'));
  expect(await resolve()).toBeNull();
});

it('rejects an untracked or orphaned conversation', async () => {
  await fixture.db
    .update(conversationRegistryTable)
    .set({ untrackedAt: '2026-01-02T00:00:00.000Z' })
    .where(eq(conversationRegistryTable.id, 'caller'));
  expect(await resolve()).toBeNull();
  await fixture.db
    .update(conversationRegistryTable)
    .set({ untrackedAt: null, taskId: null })
    .where(eq(conversationRegistryTable.id, 'caller'));
  expect(await resolve()).toBeNull();
});
