import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import {
  checkoutSelector,
  getSourceControlClient,
} from '@core/features/source-control/api/browser/client';
import { commitRef } from '@core/primitives/git/api';

const PAGE_SIZE = 50;

export type CommitRangeSource = 'pull-request' | 'branch';

export type CommitRange = {
  source: CommitRangeSource;
  baseRefOid: string;
  headRefOid: string;
};

export function commitRangeForPullRequest(pr: PullRequest): CommitRange {
  return {
    source: 'pull-request',
    baseRefOid: pr.baseRefOid,
    headRefOid: pr.headRefOid,
  };
}

/** The one range this Changes section lists. A pull request wins over the local branch. */
export function sectionCommitRange(
  currentPr: PullRequest | undefined,
  branch: { defaultBranchOid: string | undefined; headOid: string | undefined }
): CommitRange | undefined {
  if (currentPr) return commitRangeForPullRequest(currentPr);
  if (branch.defaultBranchOid && branch.headOid && branch.defaultBranchOid !== branch.headOid) {
    return {
      source: 'branch',
      baseRefOid: branch.defaultBranchOid,
      headRefOid: branch.headOid,
    };
  }
  return undefined;
}

/** Shown when the log query failed and no previous page is left to display. */
export const COMMIT_LIST_LOAD_ERROR = 'Could not load commits';

export function commitListLoadFailed(isError: boolean, hasData: boolean): boolean {
  return isError && !hasData;
}

export const commitsQueryKey = (
  projectId: string,
  workspaceId: string,
  source: CommitRangeSource,
  baseRefOid: string,
  headRefOid: string
) => [projectId, workspaceId, 'commits', source, baseRefOid, headRefOid] as const;

export function useCommits(projectId: string, workspaceId: string, range: CommitRange | undefined) {
  const source = range?.source ?? 'branch';
  const baseRefOid = range?.baseRefOid ?? '';
  const headRefOid = range?.headRefOid ?? '';

  return useInfiniteQuery({
    queryKey: commitsQueryKey(projectId, workspaceId, source, baseRefOid, headRefOid),
    queryFn: async ({ pageParam }: { pageParam: number }) => {
      if (!range) return { commits: [], aheadCount: 0 };

      const client = await getSourceControlClient();
      const result = await client.checkout.getLog({
        ...checkoutSelector(workspaceId),
        options: {
          limit: PAGE_SIZE,
          skip: pageParam,
          base: commitRef(range.baseRefOid),
          head: commitRef(range.headRefOid),
        },
      });
      if (!result.success) throw new Error('Failed to load commits');
      return { commits: result.data.commits, aheadCount: result.data.totalCount };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _all, lastPageParam) =>
      lastPage.commits.length === PAGE_SIZE ? lastPageParam + PAGE_SIZE : undefined,
    enabled: !!range,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}
