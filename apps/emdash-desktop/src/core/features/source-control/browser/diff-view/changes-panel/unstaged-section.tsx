import { encodeResourceUri } from '@emdash/core/primitives/path/api';
import type { GitChange } from '@emdash/core/runtimes/git/api';
import { EmptyState } from '@emdash/ui/react/components';
import { Button, toast } from '@emdash/ui/react/primitives';
import { Plus, Undo2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getEditorClient } from '@core/features/editor/api/browser/client';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import { formatErrorType } from '@core/features/tasks/api/browser/utils';
import {
  useTaskComposition,
  useWorkspace,
} from '@core/features/workbench/api/browser/task-composition-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import { commitRef, HEAD_REF } from '@core/primitives/git/api';
import { activeDiffEntry } from '../pane-selectors';
import { ActionCard } from './components/action-card';
import { ChangesListOrTree } from './components/changes-list-or-tree';
import { ChangesViewModeToggle } from './components/changes-view-mode-toggle';
import { CommitCard } from './components/commit-card';
import { SectionHeader } from './components/section-header';
import { useChangesViewMode } from './hooks/use-changes-view-mode';
import { usePrefetchDiffModels } from './hooks/use-prefetch-diff-models';

/** Always-visible header row; rendered as a direct child of the sections group. */
export const UnstagedSectionHeader = observer(function UnstagedSectionHeader() {
  const taskView = useTaskComposition();
  const workspace = useWorkspace();
  const git = workspace.get(gitCheckoutStoreToken);
  const changesView = taskView.diffView?.changesView;
  const { mode: viewMode, setMode: setViewMode } = useChangesViewMode('unstaged');

  if (!changesView) return null;

  return (
    <SectionHeader
      label="Changed"
      collapsed={!changesView.expandedSections.unstaged}
      onToggleCollapsed={() => changesView.toggleExpanded('unstaged')}
      count={git.unstagedFileChanges.length}
      selectionState={changesView.unstagedSelectionState}
      onToggleAll={() => changesView.toggleAllUnstaged()}
      actions={<ChangesViewModeToggle value={viewMode} onChange={setViewMode} label="Changed" />}
    />
  );
});

/** Section body; mounted inside a Resizable.Panel only while the section is expanded. */
export const UnstagedSectionBody = observer(function UnstagedSectionBody() {
  const taskView = useTaskComposition();
  const workspace = useWorkspace();
  const git = workspace.get(gitCheckoutStoreToken);
  const diffView = taskView.diffView;
  const changesView = diffView?.changesView;

  const changes = git.unstagedFileChanges;
  const hasChanges = changes.length > 0;
  const hasStagedChanges = git.stagedFileChanges.length > 0;

  const _activeDiff = activeDiffEntry(taskView.activePane);
  const activePath = _activeDiff?.diffGroup === 'disk' ? _activeDiff.path : undefined;

  const prefetch = usePrefetchDiffModels('disk', HEAD_REF);

  const { mode: viewMode } = useChangesViewMode('unstaged');

  const openConfirmActionModal = useOpenModal('confirmActionModal');

  if (!diffView || !changesView) return null;

  const handleSelectChange = (change: GitChange) => {
    taskView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          type: 'disk',
          group: 'disk',
          originalRef: commitRef('HEAD'),
        },
        status: change.status,
      },
      { preview: true }
    );
  };

  const handleDoubleClickChange = (change: GitChange) => {
    taskView.activePane.open(
      'diff',
      {
        activeFile: {
          path: change.path,
          type: 'disk',
          group: 'disk',
          originalRef: commitRef('HEAD'),
        },
        status: change.status,
      },
      { preview: false }
    );
  };

  const handleDiscardSelection = () => {
    const paths = [...changesView.unstagedSelection];
    void (async () => {
      const outcome = await openConfirmActionModal({
        title: 'Discard Files Changes',
        variant: 'destructive',
        description:
          'Are you sure you want to discard the changes to the selected files? This can not be undone.',
      });
      if (!outcome.success) return;

      const result = await git.discardFiles(paths);
      if (!result.success) {
        toast.error(`Failed to discard changes: ${formatErrorType(result.error)} `);
        return;
      }
      changesView.removeUnstagedSelection(paths);
    })();
  };

  const handleDiscardAll = () => {
    void (async () => {
      // Same untracked heuristic the line-count enrichment uses: an "added"
      // entry with no additions has no git content yet.
      const untracked = changes.filter(
        (change) => change.status === 'added' && change.additions === 0
      );
      const trackedCount = changes.length - untracked.length;
      const shown = untracked.slice(0, 20);
      const description = (
        <div className="flex flex-col gap-2">
          <p>Are you sure you want to discard all changes? This can not be undone.</p>
          <p>{`Restores ${trackedCount} tracked ${trackedCount === 1 ? 'file' : 'files'}.`}</p>
          {shown.length > 0 && (
            <div className="flex flex-col gap-1">
              <p>
                {`Also deletes ${untracked.length} untracked ${
                  untracked.length === 1 ? 'file' : 'files'
                }:`}
              </p>
              <ul className="list-inside list-disc">
                {shown.map((change) => (
                  <li key={change.path}>{change.path}</li>
                ))}
                {untracked.length > shown.length && (
                  <li>{`and ${untracked.length - shown.length} more`}</li>
                )}
              </ul>
            </div>
          )}
        </div>
      );
      const outcome = await openConfirmActionModal({
        title: 'Discard All Changes',
        variant: 'destructive',
        description,
        confirmLabel: 'Discard',
        checkbox: { label: 'Also delete untracked files', defaultChecked: false },
      });
      if (!outcome.success) return;
      const includeUntracked = outcome.data?.checked ?? false;

      const result = await git.discardAllFiles({ includeUntracked });
      if (!result.success) {
        toast.error(`Failed to discard changes: ${formatErrorType(result.error)} `);
        return;
      }
      // The editor's unsaved drafts under this workspace are part of the
      // discarded changes: reload open buffers and drop the persisted rows.
      const root = encodeResourceUri(
        hostFileRefFromNativePath(workspace.path, workspace.sshConnectionId)
      );
      openFileStore.discardDirtyUnder(root);
      await (await getEditorClient()).clearBuffers({ root });
    })();
  };

  const handleStageSelection = () => {
    const paths = [...changesView.unstagedSelection];
    void git.stageFiles(paths).then((result) => {
      if (!result.success) {
        toast.error(`Failed to stage changes: ${formatErrorType(result.error)} `);
        return;
      }
      changesView.removeUnstagedSelection(paths);
    });
  };

  const handleStageAll = () => {
    void git.stageAllFiles().then((result) => {
      if (!result.success) {
        toast.error(`Failed to stage changes: ${formatErrorType(result.error)} `);
      }
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {!hasChanges && (
        <EmptyState label="Working tree clean" description="No uncommitted file changes." />
      )}
      {hasChanges && (
        <ActionCard
          selectedCount={changesView.unstagedSelection.size}
          selectionActions={
            <>
              <Button
                variant="link"
                size="xs"
                onClick={handleDiscardSelection}
                title="Discard selected files"
                className="text-foreground-destructive"
              >
                <Undo2 className="size-3" />
                Discard
              </Button>
              <Button
                variant="secondary"
                size="xs"
                onClick={handleStageSelection}
                title="Stage selected files"
              >
                <Plus className="size-3" />
                Stage
              </Button>
            </>
          }
          generalActions={
            <>
              <Button
                variant="link"
                size="xs"
                disabled={!hasChanges}
                onClick={handleDiscardAll}
                title="Discard all changes"
                className="text-foreground-destructive"
              >
                <Undo2 className="size-3" />
                Discard all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                disabled={!hasChanges}
                onClick={handleStageAll}
                title="Stage all changes"
              >
                <Plus className="size-3" />
                Stage all
              </Button>
            </>
          }
        />
      )}
      <div className="min-h-0 flex-1 px-1">
        <ChangesListOrTree
          viewMode={viewMode}
          changes={changes}
          rootPath={workspace.path}
          isSelected={(path) => changesView.unstagedSelection.has(path)}
          onToggleSelect={(path) => changesView.toggleUnstagedItem(path)}
          activePath={activePath}
          onSelectChange={handleSelectChange}
          onDoubleClickChange={handleDoubleClickChange}
          onPrefetch={(change) => prefetch(change.path)}
        />
      </div>
      {hasChanges && !hasStagedChanges && <CommitCard autoStage />}
    </div>
  );
});
