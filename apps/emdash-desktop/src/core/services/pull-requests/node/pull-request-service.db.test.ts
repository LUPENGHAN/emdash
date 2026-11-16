import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import type {
  PullRequestPage,
  PullRequestRepositoryClient,
} from '@emdash/plugins/pull-requests/types';
import { err, ok } from '@emdash/shared';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import { requestPriorities } from '@emdash/shared/requests';
import { createStubLogger } from '@emdash/shared/testing';
import type { ContractClient } from '@emdash/wire/rpc';
import { snapshot } from '@emdash/wire/state';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitPlatformAuthContract } from '../api';
import { pullRequestsContract } from '../api/contract';
import type { PullRequestError } from '../api/errors';
import type { PullRequestMergedObservation } from '../api/schemas';
import type { PullRequestEngine } from './engine';
import { PullRequestService } from './pull-request-service';
import { PullRequestStore, pullRequestSqliteStore } from './store';
import { createPullRequestsWireController } from './wire-controller';

const repositoryUrl = 'https://github.com/emdash/emdash';
const scopes: Scope[] = [];

it('publishes a merged fact only after accepted metadata is saved and does not repeat it', async () => {
  const h = await harness();
  const wire = createTestWire(
    pullRequestsContract,
    createPullRequestsWireController(h.service, h.scope)
  );
  h.scope.add(() => wire.dispose());
  const changed = vi.fn((event: PullRequestMergedObservation) => {
    expect(h.store.getPullRequestByUrl(event.url)?.status).toBe('merged');
  });
  h.scope.add(await wire.client.merged.subscribe(undefined, { onEvent: changed }));
  const original = pullRequestFixture({
    identifier: '#7',
    url: `${repositoryUrl}/pull/7`,
    status: 'open',
  });
  h.store.savePullRequest(original);
  h.context.fetchPullRequest.mockResolvedValue(observed(original));
  await h.service.mergePullRequest(
    repositoryUrl,
    7,
    { strategy: 'merge' },
    new AbortController().signal
  );
  expect(changed).not.toHaveBeenCalled();
  h.context.fetchPullRequest.mockResolvedValue(observed({ ...original, status: 'merged' }));
  expect(await h.service.refreshPullRequest({ repositoryUrl, number: 7, policy: 'force' })).toEqual(
    ok()
  );
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({
      repositoryUrl,
      baseRefName: original.baseRefName,
      headRefOid: original.headRefOid,
    })
  );
  await h.service.refreshPullRequest({ repositoryUrl, number: 7, policy: 'force' });
  expect(changed).toHaveBeenCalledOnce();
});
afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.dispose();
  vi.useRealTimers();
});
function page(prs: PullRequest[] = [], endCursor: string | null = null): PullRequestPage {
  return { prs, pageInfo: { hasNextPage: endCursor !== null, endCursor }, totalCount: prs.length };
}
function observed<T>(data: T) {
  return ok({ data, fetchedAt: Date.now() });
}
async function harness(maxSyncCount = 300) {
  const scope = createScope();
  scopes.push(scope);
  const handle = await pullRequestSqliteStore.openTemp();
  scope.add(() => handle.close());
  const store = new PullRequestStore(handle);
  store.registerRepository(repositoryUrl);
  const context = {
    identity: 'github.com:account-1',
    repositoryUrl,
    fetchOpenPage: vi.fn<PullRequestRepositoryClient['fetchOpenPage']>(
      async (_cursor: string | null, _signal: AbortSignal, _priority?: number) => observed(page())
    ),
    fetchHistoryPage: vi.fn<PullRequestRepositoryClient['fetchHistoryPage']>(
      async (_cursor: string | null, _signal: AbortSignal, _priority?: number) => observed(page())
    ),
    fetchPullRequest: vi.fn<PullRequestRepositoryClient['fetchPullRequest']>(
      async (number: number, _signal: AbortSignal, _priority?: number) =>
        observed(
          pullRequestFixture({ identifier: `#${number}`, url: `${repositoryUrl}/pull/${number}` })
        )
    ),
    fetchChecks: vi.fn<PullRequestRepositoryClient['fetchChecks']>(
      async (_number: number, _signal: AbortSignal) => observed({ headRefOid: 'head', checks: [] })
    ),
    fetchComments: vi.fn<PullRequestRepositoryClient['fetchComments']>(
      async (_number: number, _signal: AbortSignal) => observed([])
    ),
  };
  const engine = {
    findOpenPullRequests: vi.fn<PullRequestEngine['findOpenPullRequests']>(async () =>
      ok({ prs: [], complete: true })
    ),
    openRepository: vi.fn<PullRequestEngine['openRepository']>(async () =>
      ok(context as PullRequestRepositoryClient)
    ),
    createPullRequest: vi.fn(async () => ok({ url: `${repositoryUrl}/pull/42`, number: 42 })),
    mergePullRequest: vi.fn(async () => ok({ sha: 'abc', merged: true })),
    markReadyForReview: vi.fn(async () => ok()),
  };
  const { logger, calls } = createStubLogger();
  const service = new PullRequestService({
    scope,
    store,
    logger,
    githubAuth: fakeGitHubAuth(),
    engine: engine as unknown as PullRequestEngine,
    incrementalIntervalMs: 60_000,
    maxSyncCount,
  });
  const state = service.observeRepository(repositoryUrl, scope);
  return {
    scope,
    handle,
    store,
    context,
    engine,
    service,
    calls,
    state: () => snapshot(state).value,
  };
}

describe('PullRequestService ownership', () => {
  const creation = {
    repositoryUrl,
    headRepositoryUrl: 'https://github.com/personal/emdash',
    head: 'personal:feature',
    base: 'develop',
    title: 'Feature',
    draft: false,
  };
  it('returns the exact matching PR without creating another one', async () => {
    const h = await harness();
    const existing = { url: `${repositoryUrl}/pull/7`, number: 7 };
    h.engine.findOpenPullRequests.mockResolvedValue(ok({ prs: [existing], complete: true }));
    expect(await h.service.ensurePullRequest(creation, new AbortController().signal)).toEqual(
      ok(existing)
    );
    expect(h.engine.findOpenPullRequests).toHaveBeenCalledWith(
      {
        repositoryUrl,
        headRepositoryUrl: creation.headRepositoryUrl,
        headRefName: 'feature',
        base: 'develop',
      },
      expect.any(AbortSignal)
    );
    expect(h.engine.createPullRequest).not.toHaveBeenCalled();
    expect(h.context.fetchPullRequest).toHaveBeenCalledWith(
      7,
      expect.any(AbortSignal),
      expect.anything()
    );
    expect(h.store.getPullRequestByUrl(existing.url)?.url).toBe(existing.url);
  });
  it.each([true, false])(
    'refuses ambiguous or incomplete matching inventory (%s)',
    async (complete) => {
      const h = await harness();
      const candidates = [7, 8].map((number) => ({
        url: `${repositoryUrl}/pull/${number}`,
        number,
      }));
      h.engine.findOpenPullRequests.mockResolvedValue(ok({ prs: candidates, complete }));
      expect(
        await h.service.ensurePullRequest(creation, new AbortController().signal)
      ).toMatchObject({
        success: false,
        error: { type: 'pull_request_match_ambiguous', candidates },
      });
      expect(h.engine.createPullRequest).not.toHaveBeenCalled();
    }
  );
  it('does not create when the authoritative matching read fails', async () => {
    const h = await harness();
    h.engine.findOpenPullRequests.mockResolvedValue(
      err({ type: 'refresh_failed', message: 'Offline' })
    );
    expect(await h.service.ensurePullRequest(creation, new AbortController().signal)).toMatchObject(
      {
        success: false,
        error: { type: 'refresh_failed' },
      }
    );
    expect(h.engine.createPullRequest).not.toHaveBeenCalled();
  });
  it('refuses an incomplete response even when its first page contains no matches', async () => {
    const h = await harness();
    h.engine.findOpenPullRequests.mockResolvedValue(ok({ prs: [], complete: false }));
    expect(await h.service.ensurePullRequest(creation, new AbortController().signal)).toMatchObject(
      {
        success: false,
        error: { type: 'pull_request_match_ambiguous', candidates: [] },
      }
    );
    expect(h.engine.createPullRequest).not.toHaveBeenCalled();
  });
  it('rejects a management source before matching or creating on the hosting platform', async () => {
    const h = await harness();
    expect(
      await h.service.ensurePullRequest(
        {
          ...creation,
          head: 'personal:emdash/manage/documents',
        },
        new AbortController().signal
      )
    ).toMatchObject({
      success: false,
      error: { type: 'management_branch' },
    });
    expect(h.engine.findOpenPullRequests).not.toHaveBeenCalled();
    expect(h.engine.createPullRequest).not.toHaveBeenCalled();
  });
  it('serializes matching reads and recovers a created PR after a lost creation response', async () => {
    const h = await harness();
    const created = { url: `${repositoryUrl}/pull/42`, number: 42 };
    h.engine.createPullRequest.mockImplementationOnce(async () => {
      h.engine.findOpenPullRequests.mockResolvedValue(ok({ prs: [created], complete: true }));
      throw new Error('Response disconnected');
    });
    const first = h.service.ensurePullRequest(creation, new AbortController().signal);
    const rejected = expect(first).rejects.toThrow('Response disconnected');
    const second = h.service.ensurePullRequest(creation, new AbortController().signal);
    await rejected;
    expect(await second).toEqual(ok(created));
    expect(h.engine.createPullRequest).toHaveBeenCalledOnce();
  });
  it('stores GitLab details and comments under the merge request web URL', async () => {
    const h = await harness();
    const mrUrl = `${repositoryUrl}/-/merge_requests/42`;
    const mr = pullRequestFixture({ url: mrUrl, provider: 'gitlab', identifier: '!42' });
    h.store.savePullRequest(mr);
    h.context.fetchPullRequest.mockResolvedValueOnce(observed(mr));
    h.context.fetchComments.mockResolvedValueOnce(
      observed([
        {
          id: 'note-1',
          pullRequestUrl: mrUrl,
          kind: 'issue',
          body: 'Comment',
          url: `${mrUrl}#note_1`,
          author: null,
          path: null,
          line: null,
          isResolved: false,
          isOutdated: false,
          createdAt: mr.createdAt,
          updatedAt: mr.updatedAt,
        },
      ])
    );
    expect(
      await h.service.refreshPullRequest({
        repositoryUrl,
        number: 42,
        comments: true,
        policy: 'force',
      })
    ).toEqual(ok());
    expect(h.store.getPullRequestByNumber(repositoryUrl, 42)?.url).toBe(mrUrl);
    expect(h.store.getComments(mrUrl)).toMatchObject([{ id: 'note-1' }]);
  });

  it('hydrates incomplete MR inventory and preserves freshness only for unchanged observations', async () => {
    const h = await harness();
    const mr = pullRequestFixture({
      provider: 'gitlab',
      identifier: '!42',
      url: `${repositoryUrl}/-/merge_requests/42`,
      reviewDecision: 'APPROVED',
      baseRefOid: 'base-detail',
    });
    const summary = { ...mr, reviewDecision: null, baseRefOid: '' };
    const inventory = {
      ...page([summary]),
      detailOnlyFields: ['reviewDecision', 'baseRefOid'] as ('reviewDecision' | 'baseRefOid')[],
    };
    h.context.fetchOpenPage.mockImplementation(async () => observed(inventory));
    h.context.fetchPullRequest.mockImplementation(async () => observed(mr));
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(ok());
    expect(h.store.getPullRequestByUrl(mr.url)?.metadataFetchedAt).toBeNull();
    expect(
      await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'if-stale' })
    ).toEqual(ok());
    expect(h.context.fetchPullRequest).toHaveBeenCalledTimes(1);
    expect(h.store.getPullRequestByUrl(mr.url)).toMatchObject({
      reviewDecision: 'APPROVED',
      baseRefOid: 'base-detail',
    });
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    expect(h.store.getPullRequestByUrl(mr.url)).toMatchObject({
      reviewDecision: 'APPROVED',
      baseRefOid: 'base-detail',
    });
    await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'if-stale' });
    expect(h.context.fetchPullRequest).toHaveBeenCalledTimes(1);
    summary.headRefOid = 'new-head';
    summary.updatedAt = '2026-10-19T00:00:00Z';
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    expect(h.store.getPullRequestByUrl(mr.url)?.metadataFetchedAt).toBeNull();
    await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'if-stale' });
    expect(h.context.fetchPullRequest).toHaveBeenCalledTimes(2);
  });

  it.each(['title', 'head', 'worker restart'] as const)(
    'retains omitted cached MR details after %s and a failed detail refresh',
    async (change) => {
      const h = await harness();
      const mr = pullRequestFixture({
        provider: 'gitlab',
        identifier: '!42',
        url: `${repositoryUrl}/-/merge_requests/42`,
        reviewDecision: 'APPROVED',
        baseRefOid: 'base-detail',
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        commitCount: 4,
      });
      if (change === 'worker restart') {
        h.store.savePullRequest({ ...mr, metadataFetchedAt: Date.now() });
      } else {
        h.context.fetchPullRequest.mockResolvedValueOnce(observed(mr));
        await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' });
      }
      const summary = {
        ...mr,
        reviewDecision: null,
        baseRefOid: '',
        additions: null,
        deletions: null,
        changedFiles: null,
        commitCount: null,
        ...(change === 'title' ? { title: 'Renamed MR', updatedAt: '2026-10-20T00:00:00Z' } : {}),
        ...(change === 'head' ? { headRefOid: 'new-head', updatedAt: '2026-10-20T00:00:00Z' } : {}),
      };
      const inventory: PullRequestPage = {
        ...page([summary]),
        detailOnlyFields: [
          'reviewDecision',
          'baseRefOid',
          'additions',
          'deletions',
          'changedFiles',
          'commitCount',
        ],
      };
      h.context.fetchOpenPage.mockResolvedValueOnce(observed(inventory));
      await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
      expect(h.store.getPullRequestByUrl(mr.url)).toMatchObject({
        title: summary.title,
        headRefOid: summary.headRefOid,
        reviewDecision: 'APPROVED',
        baseRefOid: 'base-detail',
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        commitCount: 4,
        metadataFetchedAt: null,
      });
      h.context.fetchPullRequest.mockClear();
      h.context.fetchPullRequest.mockResolvedValueOnce(
        err({ type: 'sync_failed', message: 'Detail endpoint unavailable' })
      );
      expect(
        await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'if-stale' })
      ).toMatchObject({ success: false });
      expect(h.context.fetchPullRequest).toHaveBeenCalledOnce();
      expect(h.store.getPullRequestByUrl(mr.url)).toMatchObject({
        reviewDecision: 'APPROVED',
        baseRefOid: 'base-detail',
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        commitCount: 4,
        metadataFetchedAt: null,
      });
    }
  );

  it('restores history progress after inventory completes, without losing either operation state', async () => {
    const h = await harness();
    let finishHistory!: () => void;
    let finishInventory!: () => void;
    h.context.fetchHistoryPage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishHistory = resolve;
      });
      return observed(page());
    });
    h.context.fetchOpenPage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishInventory = resolve;
      });
      return observed(page());
    });
    const history = h.service.refreshHistory(repositoryUrl);
    await vi.waitFor(() => expect(finishHistory).toBeDefined());
    expect(h.state()).toMatchObject({ phase: 'running', kind: 'history' });
    const inventory = h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    await vi.waitFor(() => expect(finishInventory).toBeDefined());
    expect(h.state()).toMatchObject({ phase: 'running', kind: 'repository' });
    finishInventory();
    await inventory;
    expect(h.state()).toMatchObject({ phase: 'running', kind: 'history' });
    finishHistory();
    await history;
    expect(h.state()).toMatchObject({ phase: 'idle', kind: 'history', outcome: 'success' });
  });

  it('does not erase an inventory failure when independent history succeeds', async () => {
    const h = await harness();
    const error: PullRequestError = { type: 'sync_failed', message: 'Inventory unavailable' };
    h.context.fetchOpenPage.mockResolvedValueOnce(err(error));
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    await h.service.refreshHistory(repositoryUrl);
    expect(h.state()).toMatchObject({ phase: 'error', kind: 'repository', error });
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    expect(h.state()).toMatchObject({ phase: 'idle', kind: 'repository', outcome: 'success' });
  });

  it.each(['inventory', 'history'] as const)(
    'retries bootstrap history after an initial %s failure',
    async (failed) => {
      vi.useFakeTimers();
      const h = await harness();
      if (failed === 'inventory')
        h.context.fetchOpenPage.mockResolvedValueOnce(
          err({ type: 'sync_failed', message: 'Offline' })
        );
      else
        h.context.fetchHistoryPage.mockResolvedValueOnce(
          err({ type: 'sync_failed', message: 'Offline' })
        );
      h.service.registerRepository(repositoryUrl);
      await vi.advanceTimersByTimeAsync(0);
      h.context.fetchHistoryPage.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    {
      type: 'account_not_found',
      integrationId: 'github',
      message: 'Selected account disconnected',
    },
    { type: 'integration_disabled', integrationId: 'github', message: 'GitHub disabled' },
    { type: 'auth_required', integrationId: 'github', host: 'github.com', hint: 'Reconnect' },
    {
      type: 'account_host_mismatch',
      integrationId: 'github',
      message: 'Account belongs to another host',
      accountId: 'account-1',
      accountHost: 'ghe.example.com',
      host: 'github.com',
    },
    {
      type: 'token_missing',
      integrationId: 'github',
      message: 'Token missing',
      accountId: 'account-1',
      host: 'github.com',
    },
  ] satisfies PullRequestError[])(
    'rejects a late old-account response after $type',
    async (error) => {
      const h = await harness();
      let finish!: () => void;
      h.context.fetchOpenPage.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return observed(page([pullRequestFixture({ title: 'Old account response' })]));
      });
      const pending = h.service.refreshRepository({ repositoryUrl, policy: 'force' });
      await vi.waitFor(() => expect(finish).toBeDefined());
      h.engine.openRepository.mockResolvedValueOnce(err(error));
      expect(
        await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' })
      ).toMatchObject({ success: false });
      finish();
      expect(await pending).toMatchObject({ success: false });
      expect(h.store.getPullRequestByUrl(`${repositoryUrl}/pull/42`)).toBeNull();
      expect(h.state().lastSyncedAt !== undefined).toBe(false);
    }
  );

  it('keeps valid in-flight work when another auth request has a transient transport failure', async () => {
    const h = await harness();
    let finish!: () => void;
    h.context.fetchOpenPage.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return observed(page([pullRequestFixture()]));
    });
    const pending = h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.engine.openRepository.mockResolvedValueOnce(
      err({ type: 'host_unreachable', host: 'github.com', reason: 'Transient outage' })
    );
    await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' });
    finish();
    expect(await pending).toEqual(ok());
    expect(h.state().lastSyncedAt !== undefined).toBe(true);
  });

  it('fences an old auth resolution even when rejection arrived before the first identity was accepted', async () => {
    const h = await harness();
    let finish!: () => void;
    h.engine.openRepository.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return ok(h.context);
    });
    const pending = h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.engine.openRepository.mockResolvedValueOnce(
      err({ type: 'integration_disabled', integrationId: 'github', message: 'Disabled' })
    );
    await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' });
    finish();
    expect(await pending).toMatchObject({ success: false });
    expect(h.context.fetchOpenPage).not.toHaveBeenCalled();
  });

  it('ignores a late access rejection from an older resolution after newer access succeeded', async () => {
    const h = await harness();
    let finish!: () => void;
    h.engine.openRepository.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return err({
        type: 'integration_disabled',
        integrationId: 'github',
        message: 'Old rejection',
      });
    });
    const pending = h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(ok());
    finish();
    await pending;
    expect(h.state().lastSyncedAt !== undefined).toBe(true);
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'if-stale' })).toEqual(ok());
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(1);
  });

  it('resumes failed bootstrap history from the saved page and stops after completion', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.context.fetchHistoryPage.mockResolvedValueOnce(
      observed(page([pullRequestFixture()], 'next'))
    );
    h.context.fetchHistoryPage.mockResolvedValueOnce(
      err({ type: 'sync_failed', message: 'Second page unavailable' })
    );
    h.service.registerRepository(repositoryUrl);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toMatchObject({
      phase: 'error',
      kind: 'history',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.context.fetchHistoryPage.mock.calls[2]?.[0]).toBe('next');
    expect(h.store.getCursor(repositoryUrl, 'full')?.done).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(3);
  });

  it('does not retry bootstrap history after the repository is released', async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.context.fetchHistoryPage.mockResolvedValueOnce(
      err({ type: 'sync_failed', message: 'Offline' })
    );
    h.service.registerRepository(repositoryUrl);
    await vi.advanceTimersByTimeAsync(0);
    await h.service.releaseRepository(repositoryUrl);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(1);
  });

  it('cancels only the history read owned by the caller, leaving inventory available', async () => {
    const h = await harness();
    let historySignal: AbortSignal | undefined;
    h.context.fetchHistoryPage.mockImplementationOnce(async (_cursor, signal) => {
      historySignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      signal.throwIfAborted();
      return observed(page());
    });
    const controller = new AbortController();
    const history = h.service.refreshHistory(repositoryUrl, controller.signal);
    await vi.waitFor(() => expect(historySignal).toBeDefined());
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(ok());
    controller.abort();
    expect(await history).toMatchObject({ success: false });
    expect(historySignal?.aborted).toBe(true);
    expect(h.state()).toMatchObject({
      phase: 'idle',
      kind: 'history',
      outcome: 'cancelled',
    });
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(ok());
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(2);
  });

  it('cancelling a waiting history caller cannot cancel another caller or start a later read', async () => {
    const h = await harness();
    let finish!: () => void;
    let historySignal: AbortSignal | undefined;
    h.context.fetchHistoryPage.mockImplementationOnce(async (_cursor, signal) => {
      historySignal = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return observed(page());
    });
    const first = h.service.refreshHistory(repositoryUrl);
    await vi.waitFor(() => expect(historySignal).toBeDefined());
    const controller = new AbortController();
    const waiting = h.service.refreshHistory(repositoryUrl, controller.signal);
    const cancelled = expect(waiting).rejects.toThrow();
    controller.abort();
    await cancelled;
    expect(historySignal?.aborted).toBe(false);
    finish();
    expect(await first).toEqual(ok());
    expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(1);
  });

  it('polls every minute even when a request finishes after its tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = await harness();
    h.context.fetchOpenPage.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      return observed(page());
    });
    h.service.registerRepository(repositoryUrl);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(3);
    expect(h.context.fetchOpenPage).toHaveBeenLastCalledWith(
      null,
      expect.any(AbortSignal),
      requestPriorities.background
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await h.scope.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(3);
  });

  it('settles cancelled inventory before closing SQLite', async () => {
    const h = await harness();
    let started = false;
    let databaseOpen = false;
    h.context.fetchOpenPage.mockImplementation(async (_cursor, signal) => {
      started = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            databaseOpen =
              h.handle.connection.get<{ value: number }>('SELECT 1 AS value')?.value === 1;
            resolve();
          },
          { once: true }
        )
      );
      return observed(page());
    });
    const pending = h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    await vi.waitFor(() => expect(started).toBe(true));
    await h.scope.dispose();
    expect(await pending).toMatchObject({ success: false });
    expect(databaseOpen).toBe(true);
    expect(() => h.handle.connection.get('SELECT 1')).toThrow();
  });

  it('settles scoped RPC operations before closing SQLite', async () => {
    const h = await harness();
    let started = false;
    let databaseOpen = false;
    const operation = h.service.runOperation('test', undefined, async (signal) => {
      started = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            databaseOpen =
              h.handle.connection.get<{ value: number }>('SELECT 1 AS value')?.value === 1;
            resolve();
          },
          { once: true }
        )
      );
      return ok();
    });
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(started).toBe(true));
    await h.scope.dispose();
    await rejected;
    expect(databaseOpen).toBe(true);
    expect(() => h.handle.connection.get('SELECT 1')).toThrow();
  });

  it('owns mutation invalidation and accepts refreshed provider observations', async () => {
    const h = await harness();
    await h.service.createPullRequest(
      { repositoryUrl, title: 'Created', head: 'feature', base: 'main', body: '', draft: false },
      new AbortController().signal
    );
    await h.service.mergePullRequest(
      repositoryUrl,
      42,
      { strategy: 'merge' },
      new AbortController().signal
    );
    await h.service.markReadyForReview(repositoryUrl, 42, new AbortController().signal);
    expect(h.context.fetchPullRequest).toHaveBeenCalledTimes(3);
    expect(h.context.fetchChecks).toHaveBeenCalledTimes(3);
    expect(h.store.getPullRequestByUrl(`${repositoryUrl}/pull/42`)).toMatchObject({
      title: 'Feature',
      metadataFetchedAt: expect.any(Number),
    });
  });

  it('starts inventory on registration, gates automatic work, and honors manual refresh', async () => {
    const h = await harness();
    h.service.registerRepository(repositoryUrl);
    await vi.waitFor(() => expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(1));
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(1);
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(ok());
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(2);
    expect(h.context.fetchOpenPage).toHaveBeenLastCalledWith(
      null,
      expect.any(AbortSignal),
      requestPriorities.task
    );
    await h.service.refreshRepository({ repositoryUrl, policy: 'if-stale' });
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(2);
    await h.service.refreshHistory(repositoryUrl);
    expect(h.context.fetchHistoryPage).toHaveBeenCalledTimes(2);
  });

  it('does not let individual PR refresh postpone inventory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = await harness();
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    vi.setSystemTime(59_000);
    await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' });
    expect(h.state().lastSyncedAt).toBe(0);
    vi.setSystemTime(60_000);
    await h.service.refreshRepository({ repositoryUrl, policy: 'if-stale' });
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(2);
  });

  it('never advances inventory freshness from successful historical synchronization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const h = await harness();
    await h.service.refreshHistory(repositoryUrl);
    expect(h.state().lastSyncedAt !== undefined).toBe(false);
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    const freshAt = h.state().lastSyncedAt;
    vi.setSystemTime(31_000);
    await h.service.refreshHistory(repositoryUrl);
    expect(h.state().lastSyncedAt).toBe(freshAt);
    expect(h.state()?.lastSyncedAt).toBe(freshAt);
  });

  it('retains inventory freshness after a failed explicit refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = await harness();
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    h.context.fetchOpenPage.mockResolvedValueOnce(
      err({ type: 'sync_failed', message: 'GitHub unavailable' })
    );
    vi.setSystemTime(10_000);
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(
      err({ type: 'sync_failed', message: 'GitHub unavailable' })
    );
    expect(h.state().lastSyncedAt).toBe(0);
    vi.setSystemTime(20_000);
    await h.service.refreshRepository({ repositoryUrl, policy: 'if-stale' });
    expect(h.context.fetchOpenPage).toHaveBeenCalledTimes(2);
  });

  it('keeps foreground inventory independent of delayed historical work', async () => {
    const h = await harness();
    let finish!: () => void;
    h.context.fetchHistoryPage.mockImplementationOnce(async (_cursor, signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return observed(page());
    });
    const history = h.service.refreshHistory(repositoryUrl);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await h.service.refreshRepository({ repositoryUrl, policy: 'force' })).toEqual(ok());
    expect(h.state().lastSyncedAt !== undefined).toBe(true);
    finish();
    expect(await history).toEqual(ok());
  });

  it('invalidates history cursors and inventory freshness when identity changes', async () => {
    const h = await harness();
    await h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    h.store.setCursor(repositoryUrl, 'full', { done: true, lastUpdatedAt: '2026-01-02T00:00:00Z' });
    h.context.identity = 'github.com:account-2';
    await h.service.refreshPullRequest({ repositoryUrl, number: 42, policy: 'force' });
    expect(h.store.getCursor(repositoryUrl, 'full')).toBeNull();
    expect(h.state().lastSyncedAt !== undefined).toBe(false);
  });

  it('fences a pending old-account observation after an account change', async () => {
    const h = await harness();
    let finish!: () => void;
    h.context.fetchOpenPage.mockImplementationOnce(async (_cursor, signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return observed(page([pullRequestFixture({ title: 'Old account' })]));
    });
    const inventory = h.service.refreshRepository({ repositoryUrl, policy: 'force' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    h.context.identity = 'github.com:account-2';
    await h.service.refreshPullRequest({ repositoryUrl, number: 1, policy: 'force' });
    finish();
    expect(await inventory).toMatchObject({ success: false });
    expect(h.store.getPullRequestByUrl(`${repositoryUrl}/pull/1`)?.title).toBe('Feature');
    expect(h.state().lastSyncedAt !== undefined).toBe(false);
  });

  it('resumes interrupted history without advancing the saved boundary', async () => {
    const h = await harness();
    h.context.fetchHistoryPage
      .mockResolvedValueOnce(observed(page([pullRequestFixture()], 'next')))
      .mockResolvedValueOnce(err({ type: 'sync_failed', message: 'Unavailable' }));
    expect(await h.service.refreshHistory(repositoryUrl)).toMatchObject({ success: false });
    expect(h.store.getCursor(repositoryUrl, 'full')).toMatchObject({
      done: false,
      pageCursor: 'next',
    });
    h.context.fetchHistoryPage.mockResolvedValueOnce(
      observed(page([pullRequestFixture({ identifier: '#2', url: `${repositoryUrl}/pull/2` })]))
    );
    await h.service['startHistory'](repositoryUrl, false, requestPriorities.background);
    expect(h.context.fetchHistoryPage).toHaveBeenLastCalledWith(
      'next',
      expect.any(AbortSignal),
      requestPriorities.background,
      undefined
    );
    expect(h.store.getCursor(repositoryUrl, 'full')).toMatchObject({ done: true });
    expect(
      h.store.listPullRequests({ repositoryUrls: [repositoryUrl], cursor: null, limit: 10 }).prs
    ).toHaveLength(2);
  });

  it('preserves the incremental boundary across an interrupted history page', async () => {
    const h = await harness();
    const boundary = '2026-01-02T00:00:00.000Z';
    h.store.setCursor(repositoryUrl, 'full', { done: true, lastUpdatedAt: boundary });
    h.context.fetchHistoryPage
      .mockResolvedValueOnce(
        observed(page([pullRequestFixture({ updatedAt: '2026-01-04T00:00:00.000Z' })], 'older'))
      )
      .mockResolvedValueOnce(err({ type: 'sync_failed', message: 'Unavailable' }));
    expect(
      await h.service['startHistory'](repositoryUrl, false, requestPriorities.background)
    ).toMatchObject({ success: false });
    expect(h.store.getCursor(repositoryUrl, 'incremental')).toMatchObject({
      done: false,
      pageCursor: 'older',
      lastUpdatedAt: boundary,
    });
    h.context.fetchHistoryPage.mockResolvedValueOnce(
      observed(
        page([
          pullRequestFixture({
            identifier: '#2',
            url: `${repositoryUrl}/pull/2`,
            updatedAt: '2026-01-03T00:00:00.000Z',
          }),
          pullRequestFixture({
            identifier: '#3',
            url: `${repositoryUrl}/pull/3`,
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        ])
      )
    );
    expect(
      await h.service['startHistory'](repositoryUrl, false, requestPriorities.background)
    ).toEqual(ok());
    expect(h.context.fetchHistoryPage).toHaveBeenLastCalledWith(
      'older',
      expect.any(AbortSignal),
      requestPriorities.background,
      '2026-01-02T00:00:00.000Z'
    );
    expect(h.store.getPullRequestByUrl(`${repositoryUrl}/pull/2`)).not.toBeNull();
    expect(h.store.getPullRequestByUrl(`${repositoryUrl}/pull/3`)).toBeNull();
    expect(h.store.getCursor(repositoryUrl, 'incremental')?.done).toBe(true);
  });

  it('falls back to a full history after incremental overflow', async () => {
    const h = await harness(2);
    h.store.setCursor(repositoryUrl, 'full', {
      done: true,
      lastUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    h.context.fetchHistoryPage.mockResolvedValueOnce(
      observed(
        page(
          [
            pullRequestFixture(),
            pullRequestFixture({ identifier: '#2', url: `${repositoryUrl}/pull/2` }),
          ],
          'more'
        )
      )
    );
    expect(
      await h.service['startHistory'](repositoryUrl, false, requestPriorities.background)
    ).toEqual(ok());
    expect(h.store.getCursor(repositoryUrl, 'full')).toBeNull();
    expect(h.store.getCursor(repositoryUrl, 'incremental')).toBeNull();
    await h.service['startHistory'](repositoryUrl, false, requestPriorities.background);
    expect(h.context.fetchHistoryPage).toHaveBeenLastCalledWith(
      null,
      expect.any(AbortSignal),
      requestPriorities.background,
      undefined
    );
    expect(h.store.getCursor(repositoryUrl, 'full')?.done).toBe(true);
  });

  it('keeps a successful mutation result when its refresh fails', async () => {
    const h = await harness();
    h.context.fetchPullRequest.mockResolvedValueOnce(
      err({ type: 'refresh_failed', message: 'Refresh failed' })
    );
    expect(
      await h.service.mergePullRequest(
        repositoryUrl,
        42,
        { strategy: 'merge' },
        new AbortController().signal
      )
    ).toEqual(ok({ sha: 'abc', merged: true }));
    expect(h.calls).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Pull request refresh failed after mutation',
      })
    );
  });

  it('validates canonical PR URLs against one registered repository cache', async () => {
    const h = await harness();
    const pr = h.store.savePullRequest(pullRequestFixture());
    expect(h.service.getPullRequestByUrl(repositoryUrl, pr.url)).toEqual(ok({ pr }));
    expect(h.service.getPullRequestByUrl(`${repositoryUrl}.git`, pr.url)).toEqual(ok({ pr }));
    expect(h.service.getPullRequestByUrl('https://github.com/other/project', pr.url)).toEqual(
      ok({ pr: null })
    );
    expect(h.service.getPullRequestByUrl(repositoryUrl, `${repositoryUrl}/pull/999`)).toEqual(
      ok({ pr: null })
    );
    await h.service.unregisterRepository(repositoryUrl);
    expect(h.service.getPullRequestByUrl(repositoryUrl, pr.url)).toEqual(ok({ pr: null }));
    expect(h.service.getPullRequestByUrl('not a repository', pr.url)).toEqual(
      err({ type: 'invalid_repository', input: 'not a repository' })
    );
  });
});
function pullRequestFixture(overrides: Partial<PullRequest> = {}): PullRequest {
  const repositoryUrl = 'https://github.com/emdash/emdash';
  return {
    url: `${repositoryUrl}/pull/1`,
    provider: 'github',
    repositoryUrl,
    baseRefName: 'main',
    baseRefOid: 'base',
    headRepositoryUrl: repositoryUrl,
    headRefName: 'feature',
    headRefOid: 'head',
    identifier: '#1',
    title: 'Feature',
    description: null,
    status: 'open',
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    commitCount: 1,
    mergeableStatus: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

function fakeGitHubAuth(): ContractClient<GitPlatformAuthContract> {
  return {
    resolveIntegration: async () => ok({ integrationId: 'github' }),
    resolveAuth: async () =>
      ok({
        integrationId: 'github',
        credentials: { accessToken: 'test-token', apiBaseUrl: 'https://api.github.com' },
      }),
  };
}

it.each([
  'emdash/manage/id',
  'refs/heads/emdash/manage/id',
  'refs/remotes/fork/emdash/manage/id',
  'owner:emdash/manage/id',
  'owner:refs/heads/emdash/manage/id',
])('rejects management PR source %s before contacting the provider', async (head) => {
  const h = await harness();
  const result = await h.service.createPullRequest(
    { repositoryUrl, title: 'Must not create', head, base: 'main', draft: false },
    new AbortController().signal
  );
  expect(result).toMatchObject({ success: false, error: { type: 'management_branch' } });
  expect(h.engine.createPullRequest).not.toHaveBeenCalled();
});
