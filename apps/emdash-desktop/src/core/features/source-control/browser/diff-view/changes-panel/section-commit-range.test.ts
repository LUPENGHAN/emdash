import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import { describe, expect, it } from 'vitest';
import {
  effectivePrTabOf,
  prTabAfterUrlChange,
} from '@core/features/source-control/api/browser/diff-view/stores/diff-view-store';
import {
  COMMIT_LIST_LOAD_ERROR,
  commitListLoadFailed,
  sectionCommitRange,
} from './components/pr-entry/use-commits';

const pullRequest = (baseRefOid: string, headRefOid: string) =>
  ({ baseRefOid, headRefOid }) as PullRequest;

const localBranch = { defaultBranchOid: 'local-base', headOid: 'local-head' };

describe('sectionCommitRange', () => {
  it('returns no branch range when the local head matches the base', () => {
    expect(
      sectionCommitRange(undefined, { defaultBranchOid: 'same', headOid: 'same' })
    ).toBeUndefined();
  });

  it('lists the local branch when there is no pull request and the oids differ', () => {
    expect(sectionCommitRange(undefined, { defaultBranchOid: 'base', headOid: 'head' })).toEqual({
      source: 'branch',
      baseRefOid: 'base',
      headRefOid: 'head',
    });
  });

  it('lists the pull request range and not the local branch', () => {
    const range = sectionCommitRange(pullRequest('pr-base', 'pr-head'), localBranch);
    expect(range).toEqual({
      source: 'pull-request',
      baseRefOid: 'pr-base',
      headRefOid: 'pr-head',
    });
    expect(range?.source).not.toBe('branch');
  });

  it('keeps an empty pull request oid instead of falling through to the branch', () => {
    expect(sectionCommitRange(pullRequest('', ''), localBranch)).toEqual({
      source: 'pull-request',
      baseRefOid: '',
      headRefOid: '',
    });
  });
});

describe('effective pull request tab', () => {
  it('opens Checks for a pull request that is not open', () => {
    expect(prTabAfterUrlChange('merged')).toBe('checks');
    expect(prTabAfterUrlChange(undefined)).toBe('checks');
    expect(prTabAfterUrlChange('open')).toBe('files');
  });

  it('shows Checks for a stored Commits tab or Files on a closed pull request', () => {
    expect(effectivePrTabOf('commits', 'open')).toBe('checks');
    expect(effectivePrTabOf('files', 'merged')).toBe('checks');
    expect(effectivePrTabOf('files', 'open')).toBe('files');
    expect(effectivePrTabOf('checks', 'closed')).toBe('checks');
  });
});

describe('commitListLoadFailed', () => {
  it('uses the load-error label only when the query failed with no page left', () => {
    expect(COMMIT_LIST_LOAD_ERROR).toBe('Could not load commits');
    expect(commitListLoadFailed(true, false)).toBe(true);
    expect(commitListLoadFailed(true, true)).toBe(false);
    expect(commitListLoadFailed(false, false)).toBe(false);
  });
});
