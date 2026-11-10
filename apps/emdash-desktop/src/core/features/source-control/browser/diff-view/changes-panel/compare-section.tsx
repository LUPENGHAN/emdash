import { toBranchRef, type GitBranchRef, type GitChange } from '@emdash/core/runtimes/git/api';
import { Button } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  checkoutSelector,
  getSourceControlClient,
} from '@core/features/source-control/api/browser/client';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { ProjectBranchSelector } from '@core/features/source-control/contributions/browser/project-branch-selector';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  useTaskComposition,
  useWorkspace,
} from '@core/features/workbench/api/browser/task-composition-context';
import { commitRef, refsEqual } from '@core/primitives/git/api';
import { activeDiffEntry } from '../pane-selectors';
import type { ChangesViewStore } from '../stores/changes-view-store';
import { ChangesListOrTree } from './components/changes-list-or-tree';
import { SectionHeader } from './components/section-header';
import { usePrefetchDiffModels } from './hooks/use-prefetch-diff-models';

function branchKey(branch: GitBranchRef): string {
  return JSON.stringify([
    branch.type,
    branch.type === 'remote' ? branch.remote.name : null,
    branch.branch,
  ]);
}

export function useCompareSection(changesView: ChangesViewStore) {
  const { projectId } = useTaskViewContext();
  const workspace = useWorkspace();
  const checkout = workspace.get(gitCheckoutStoreToken);
  const repo = getGitRepositoryStore(projectId);
  const hostState = asAvailableProject(getProjectStore(projectId))?.host.state;
  const hostGeneration = hostState?.kind === 'ready' ? hostState.hostGeneration : null;
  const [refresh, setRefresh] = useState(0);
  const [synced, setSynced] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const mode = changesView.compareMode;
  const selectedBranch = changesView.compareBranch;
  const commitInput = changesView.compareCommitInput;
  const submittedCommit = changesView.compareSubmittedCommit;
  const syncKey = hostGeneration === null ? null : `${hostGeneration}:${refresh}`;

  useEffect(() => {
    let cancelled = false;
    setSynced(null);
    setSyncError(null);
    if (syncKey && repo) {
      void Promise.all([repo.resyncRequired(), checkout.resyncRequired()]).then(
        () => {
          if (!cancelled) setSynced(syncKey);
        },
        (error: unknown) => {
          if (!cancelled) setSyncError(error instanceof Error ? error.message : String(error));
        }
      );
    }
    return () => {
      cancelled = true;
    };
  }, [syncKey, repo, checkout]);

  const ready = syncKey !== null && synced === syncKey && repo?.refsObservation.kind === 'fresh';
  const branch = selectedBranch ?? repo?.defaultBranchRef;
  const branchOid =
    branch &&
    repo?.branches.find((item) => branchKey(toBranchRef(item)) === branchKey(branch))?.oid;
  const headOid = checkout.headOid;
  const log = useQuery({
    queryKey: ['compare-log', workspace.workspaceId, syncKey, headOid],
    enabled: !!ready && mode === 'commit' && !!headOid,
    queryFn: async () => {
      const client = await getSourceControlClient();
      const result = await client.checkout.getLog({
        ...checkoutSelector(workspace.workspaceId),
        options: { limit: 50, head: commitRef(headOid!) },
      });
      if (!result.success) throw new Error('Could not load commits');
      return result.data.commits;
    },
  });
  const validInput = /^[a-fA-F0-9]{4,64}$/.test(submittedCommit);
  const commit = useQuery({
    queryKey: ['compare-commit', workspace.workspaceId, syncKey, submittedCommit],
    enabled: !!ready && mode === 'commit' && validInput,
    queryFn: async () => {
      const client = await getSourceControlClient();
      const result = await client.checkout.getCommit({
        ...checkoutSelector(workspace.workspaceId),
        hash: submittedCommit,
      });
      if (
        !result.success ||
        !result.data.commit ||
        !result.data.commit.hash.toLowerCase().startsWith(submittedCommit.toLowerCase())
      ) {
        throw new Error('Commit not found or ambiguous');
      }
      return result.data.commit;
    },
  });
  const baseOid = mode === 'branch' ? branchOid : commit.data?.hash;
  const result = useQuery({
    queryKey: ['compare-files', workspace.workspaceId, syncKey, baseOid, headOid],
    enabled: !!ready && !!baseOid && !!headOid,
    queryFn: async ({ signal }) => {
      const client = await getSourceControlClient();
      const selector = checkoutSelector(workspace.workspaceId);
      const mergeBase = await client.checkout.getMergeBase({
        ...selector,
        baseOid: baseOid!,
        headOid: headOid!,
      });
      if (!mergeBase.success)
        throw new Error('Could not determine a unique merge base. Check the repository history.');
      if (signal.aborted) throw new DOMException('Comparison cancelled', 'AbortError');
      const files = await client.checkout.getChangedFiles({
        ...selector,
        target: { kind: 'merge-base', base: commitRef(baseOid!), head: commitRef(headOid!) },
      });
      if (!files.success) throw new Error('Could not load comparison files');
      return {
        baseOid: baseOid!,
        headOid: headOid!,
        mergeBaseOid: mergeBase.data.oid,
        files: files.data.files,
      };
    },
  });
  return {
    projectId,
    workspace,
    mode,
    setMode: (value: 'branch' | 'commit') => changesView.setCompareMode(value),
    branch,
    setSelectedBranch: (value: GitBranchRef) => changesView.setCompareBranch(value),
    commitInput,
    setCommitInput: (value: string) => changesView.setCompareCommitInput(value),
    submittedCommit,
    setSubmittedCommit: (value: string) => changesView.setCompareSubmittedCommit(value),
    validInput,
    log,
    commit,
    result,
    ready,
    hostUnavailable: hostGeneration === null,
    syncError,
    headOid,
    baseOid,
    retry: () => setRefresh((value) => value + 1),
  };
}

type CompareSection = ReturnType<typeof useCompareSection>;

export const CompareSectionHeader = observer(function CompareSectionHeader({
  compare,
}: {
  compare: CompareSection;
}) {
  const changesView = useTaskComposition().diffView?.changesView;
  if (!changesView) return null;
  return (
    <SectionHeader
      label="Compare"
      count={compare.ready ? (compare.result.data?.files.length ?? 0) : 0}
      collapsed={!changesView.expandedSections.compare}
      onToggleCollapsed={() => changesView.toggleExpanded('compare')}
    />
  );
});

export const CompareSectionBody = observer(function CompareSectionBody({
  compare,
}: {
  compare: CompareSection;
}) {
  const taskView = useTaskComposition();
  const snapshot = compare.ready ? compare.result.data : undefined;
  const originalRef = useMemo(
    () => commitRef(snapshot?.mergeBaseOid ?? ''),
    [snapshot?.mergeBaseOid]
  );
  const modifiedRef = useMemo(() => commitRef(snapshot?.headOid ?? ''), [snapshot?.headOid]);
  const prefetch = usePrefetchDiffModels('git', originalRef, modifiedRef);
  const active = activeDiffEntry(taskView.activePane);
  const open = (change: GitChange, preview: boolean) => {
    if (!snapshot) return;
    taskView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          originalPath: change.originalPath,
          type: 'git',
          group: 'git',
          originalRef,
          modifiedRef,
        },
        status: change.status,
      },
      { preview }
    );
  };
  let message: string | null = null;
  if (compare.hostUnavailable) message = 'Project host is unavailable.';
  else if (compare.syncError) message = `Could not refresh Git: ${compare.syncError}`;
  else if (!compare.ready) message = 'Refreshing Git information…';
  else if (!compare.headOid) message = 'This checkout has no commits.';
  else if (compare.mode === 'branch' && !compare.baseOid)
    message = 'Select an available branch to compare.';
  else if (compare.mode === 'commit' && !compare.submittedCommit)
    message = 'Select or enter a commit.';
  else if (compare.mode === 'commit' && !compare.validInput)
    message = 'Enter a hexadecimal commit ID.';
  else if (compare.commit.isError && compare.mode === 'commit')
    message = 'Commit not found or ambiguous.';
  else if (compare.result.isError) message = compare.result.error.message;
  else if (compare.result.isFetching || (compare.mode === 'commit' && compare.commit.isFetching))
    message = 'Loading comparison…';
  else if (snapshot && snapshot.files.length === 0) message = 'No committed changes to compare.';
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <select
          aria-label="Compare target type"
          className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={compare.mode}
          onChange={(event) => compare.setMode(event.target.value as 'branch' | 'commit')}
        >
          <option value="branch">Branch</option>
          <option value="commit">Commit</option>
        </select>
        {compare.mode === 'branch' ? (
          <ProjectBranchSelector
            projectId={compare.projectId}
            value={compare.branch}
            onValueChange={compare.setSelectedBranch}
            onRefresh={compare.retry}
            selectionDisabledReason={compare.ready ? null : 'Git information is unavailable'}
          />
        ) : (
          <>
            <select
              aria-label="Recent commits"
              className="max-w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
              value=""
              onChange={(event) => {
                compare.setCommitInput(event.target.value);
                compare.setSubmittedCommit(event.target.value);
              }}
            >
              <option value="">Recent commits</option>
              {compare.log.data?.map((item) => (
                <option key={item.hash} value={item.hash}>
                  {item.hash.slice(0, 8)} {item.subject}
                </option>
              ))}
            </select>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                compare.setSubmittedCommit(compare.commitInput.trim());
              }}
              className="flex gap-1"
            >
              <input
                aria-label="Commit ID"
                value={compare.commitInput}
                onChange={(event) => compare.setCommitInput(event.target.value)}
                placeholder="Commit SHA"
                className="min-w-0 rounded border border-border bg-background px-2 text-sm"
              />
              <Button type="submit" size="xs" variant="secondary">
                Compare
              </Button>
            </form>
          </>
        )}
        <Button type="button" size="xs" variant="secondary" onClick={compare.retry}>
          Refresh
        </Button>
      </div>
      {snapshot && (
        <div
          className="truncate px-3 text-xs text-foreground-muted"
          title={`${snapshot.mergeBaseOid} → ${snapshot.headOid}`}
        >
          Merge base {snapshot.mergeBaseOid.slice(0, 8)} → HEAD {snapshot.headOid.slice(0, 8)}
        </div>
      )}
      {compare.log.isError && compare.mode === 'commit' && (
        <div className="px-3 text-xs text-foreground-muted">
          Could not load recent commits; enter a commit ID.
        </div>
      )}
      {message && (
        <div className="px-3 py-2 text-sm text-foreground-muted" role="status">
          {message}
        </div>
      )}
      {snapshot && !message && (
        <div className="min-h-0 flex-1 px-1">
          <ChangesListOrTree
            viewMode="flat"
            changes={snapshot.files}
            rootPath={compare.workspace.path}
            activePath={
              active?.diffGroup === 'git' &&
              active.modifiedRef &&
              refsEqual(active.originalRef, originalRef) &&
              refsEqual(active.modifiedRef, modifiedRef) &&
              snapshot.files.some(
                (file) =>
                  file.path === active.path &&
                  (file.originalPath ?? file.path) === (active.originalPath ?? active.path)
              )
                ? active.path
                : undefined
            }
            onSelectChange={(change) => open(change, true)}
            onDoubleClickChange={(change) => open(change, false)}
            onPrefetch={(change) => prefetch(change.path, change.originalPath)}
          />
        </div>
      )}
    </div>
  );
});
