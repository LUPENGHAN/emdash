import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import { expect, it, vi } from 'vitest';
import { taskPullRequestRecord } from '../../api/task-pull-requests';
import { savedTaskPrAssociations } from './saved-task-pr-associations';

function request() {
  return taskPullRequestRecord.schema.parse({
    version: '2',
    requestId: 'pr-1',
    fingerprint: 'fingerprint',
    phase: 'creating',
    result: { url: 'https://github.com/org/sdk/pull/7', number: 7 },
    plan: {
      taskId: 'worker',
      projectId: 'sdk',
      workspaceId: 'worktree',
      sourceRef: 'refs/heads/feature',
      oid: 'a'.repeat(40),
      pushTarget: {
        remote: 'personal',
        destination: 'https://github.com/me/sdk',
        fingerprint: 'b'.repeat(64),
      },
      repositoryUrl: 'https://github.com/org/sdk',
      headRepositoryUrl: 'https://github.com/me/sdk',
      base: 'develop',
      title: 'SDK change',
      draft: false,
    },
  });
}
const identity = { taskId: 'worker', workspaceId: 'worktree', branch: 'feature' };

it('uses the saved explicit target and deduplicates receipts before the request is complete', async () => {
  const record = request();
  const pr = { url: record.result?.url } as PullRequest;
  const byUrl = vi.fn(async () => pr);
  expect(
    await savedTaskPrAssociations({
      ...identity,
      records: [record, { ...record, requestId: 'pr-2', phase: 'complete' }],
      byUrl,
    })
  ).toEqual([pr]);
  expect(byUrl).toHaveBeenCalledExactlyOnceWith(record.plan.repositoryUrl, record.result?.url);
});

it.each([
  { taskId: 'other-worker' },
  { workspaceId: 'replacement-workspace' },
  { branch: 'another-branch' },
])('does not reuse a receipt after its source identity changed (%j)', async (changed) => {
  const byUrl = vi.fn();
  expect(
    await savedTaskPrAssociations({ ...identity, ...changed, records: [request()], byUrl })
  ).toEqual([]);
  expect(byUrl).not.toHaveBeenCalled();
});

it('does not treat a request without a platform receipt as a PR association', async () => {
  const byUrl = vi.fn();
  expect(
    await savedTaskPrAssociations({
      ...identity,
      records: [{ ...request(), result: undefined }],
      byUrl,
    })
  ).toEqual([]);
  expect(byUrl).not.toHaveBeenCalled();
});

it('keeps cache failure distinct from absence so the caller can preserve its last association', async () => {
  await expect(
    savedTaskPrAssociations({
      ...identity,
      records: [request()],
      byUrl: async () => null,
    })
  ).rejects.toThrow('not available in the platform cache');
});
