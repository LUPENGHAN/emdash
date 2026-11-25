import type { HostFileRef } from '@emdash/core/primitives/path/api';
import { EmptyState } from '@emdash/ui/react/components';
import { toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import type { FilePayload } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { getMachinesStore } from '@core/features/machines/contributions/app-stores';
import type { TaskTabContext } from '@core/features/workbench/api/browser/tabs/task-tab-context';
import { useWorkspace } from '@core/features/workbench/api/browser/task-composition-context';
import { resolveWorkspacePath } from '@core/features/workspaces/api/browser/workspace-path';
import { openModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import {
  hostFileRefFromNativePath,
  hostPathFromNative,
  relativePathWithin,
} from '@core/primitives/desktop-runtime/api';
import type {
  TabEntry,
  TabHandle,
  TabProvider,
  TabViewContext,
  TabContentProps,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import { createTabProvider } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider-registry';
import { registerLanguageContext } from '../lsp/language-services';
import { EditorProvider, useEditorContext, type EditorInsertPosition } from './editor-provider';
import { FileContentPreview } from './file-content-preview';
import { FileContentRenderer } from './file-content-renderer';
import { FileContentToolbar } from './file-content-toolbar';
import { FILE_CONTENT_TYPES } from './file-content-types';
import { FileStatusPlaceholder } from './file-status-placeholder';
import { FileTabBarItem, FileTabBarItemDragPreview } from './file-tab-item';
import { importMarkdownImages } from './markdown-image-import';
import { RecoveredStaleBanner } from './recovered-stale-banner';

export interface FileOpenArgs {
  path: string;
}

/**
 * Mounts EditorProvider unconditionally so the Monaco instance persists across
 * tab switches. The Monaco host is overlaid and visibility-toggled rather than
 * unmounted, so cursor position and scroll survive kind transitions.
 */
const FileTabContent = observer(function FileTabContent({ host, ctx }: TabContentProps) {
  return (
    <EditorProvider>
      <FileContent host={host} ctx={ctx} />
    </EditorProvider>
  );
});

/** Renders the Monaco source and/or preview for the currently active file tab. */
const FileContent = observer(function FileContent({ host, ctx }: TabContentProps) {
  const taskCtx = ctx as TaskTabContext;
  const workspace = useWorkspace();
  const { insertText, getPositionAtClientPoint } = useEditorContext();
  const [importingImages, setImportingImages] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const fileDragDepth = useRef(0);
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(
    taskCtx.projectId
  );
  const activeTab = host.resolvedTabs.find((t) => t.isActive);
  const activeFile = activeTab?.kind === 'file' ? (activeTab.resource as FileTabResource) : null;

  // Content state comes from the tab's OpenFileStore entry: anything that is
  // not ready (bounded loading, seam errors, orphaned) renders a placeholder
  // instead of the source/preview surfaces.
  const status = activeFile?.contentStatus;
  const blocked = status !== undefined && status.kind !== 'ready';

  const def = activeFile ? FILE_CONTENT_TYPES[activeFile.fileKind] : null;
  const showSource =
    !blocked && def ? def.editable && (activeFile!.viewMode === 'source' || !def.Preview) : false;
  const showPreview =
    !blocked && def
      ? !!def.Preview && (activeFile!.viewMode === 'preview' || !def.editable)
      : false;
  const canToggle = def ? def.editable && !!def.Preview : false;
  const handlesImageDrop = activeFile?.fileKind === 'markdown';
  const canImportImages =
    handlesImageDrop && !activeFile?.readOnly && !blocked && !liveActionDisabledReason;

  const importImages = useCallback(
    async (files: readonly File[], position?: EditorInsertPosition | null) => {
      if (!activeFile || activeFile.fileKind !== 'markdown') return;
      if (!canImportImages) {
        toast.error('无法导入图片', {
          description: liveActionDisabledReason ?? '当前 Markdown 文件不可写。',
        });
        return;
      }
      setImportingImages(true);
      try {
        const imported = await importMarkdownImages({
          documentPath: activeFile.path,
          sshConnectionId: workspace.sshConnectionId,
          files,
        });
        const markdown = imported.map((image) => image.markdown).join('\n');
        if (!insertText(markdown, position)) throw new Error('编辑器尚未准备好，请稍后重试。');
        activeFile.setViewMode('source');
        toast.success(imported.length > 1 ? `已导入 ${imported.length} 张图片` : '图片已导入');
      } catch (error) {
        toast.error('图片导入失败', {
          description: error instanceof Error ? error.message : '请稍后重试。',
        });
      } finally {
        setImportingImages(false);
      }
    },
    [activeFile, canImportImages, insertText, liveActionDisabledReason, workspace.sshConnectionId]
  );

  const isFileDrag = (event: DragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer.types).includes('Files');

  const handleFileDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!handlesImageDrop || !isFileDrag(event)) return;
    event.preventDefault();
    fileDragDepth.current += 1;
    setImageDragActive(true);
  };

  const handleFileDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!handlesImageDrop || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canImportImages ? 'copy' : 'none';
  };

  const handleFileDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!handlesImageDrop || !isFileDrag(event)) return;
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
    if (fileDragDepth.current === 0) setImageDragActive(false);
  };

  const handleFileDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!handlesImageDrop || !isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const position = getPositionAtClientPoint(event.clientX, event.clientY);
    fileDragDepth.current = 0;
    setImageDragActive(false);
    void importImages(Array.from(event.dataTransfer.files), position);
  };

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {activeFile && (
        <FileContentToolbar
          tab={activeFile}
          canToggle={canToggle}
          importingImages={importingImages}
          onImportImages={(files) => void importImages(files)}
        />
      )}
      {activeFile && <RecoveredStaleBanner tab={activeFile} />}
      {activeFile && liveActionDisabledReason && !blocked && (
        <div
          className="border-b bg-background-secondary px-2 py-1 text-xs text-foreground-muted"
          tabIndex={0}
          role="note"
        >
          {liveActionDisabledReason}
        </div>
      )}
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0" style={{ visibility: showSource ? 'visible' : 'hidden' }}>
          <FileContentRenderer />
        </div>
        {activeFile && blocked && liveActionDisabledReason ? (
          <div className="absolute inset-0">
            <EmptyState label="File unavailable" description={liveActionDisabledReason} />
          </div>
        ) : activeFile && blocked ? (
          <div className="absolute inset-0">
            <FileStatusPlaceholder resource={activeFile} />
          </div>
        ) : null}
        {activeFile && showPreview && (
          <div className="absolute inset-0">
            <FileContentPreview tab={activeFile} />
          </div>
        )}
        {imageDragActive ? (
          <div className="border-accent pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed bg-(--em-surface)/90 text-sm font-medium text-foreground shadow-lg">
            {canImportImages ? '松开即可导入图片' : '当前 Markdown 文件不可写'}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const languageContexts = new WeakMap<FileTabResource, () => void>();

export const fileTabProvider: TabProvider<'file', FilePayload, FileTabResource, FileOpenArgs> =
  createTabProvider({
    kind: 'file',
    mount: 'single',
    resourceKey: (s: FilePayload) => s.path,

    onBeforeOpen: (args: FileOpenArgs, ctx: TabViewContext): FilePayload | null => {
      const taskCtx = ctx as TaskTabContext;
      return { path: resolveWorkspacePath(taskCtx.workspacePath, args.path) };
    },

    initialize(
      entry: TabEntry<FilePayload>,
      handle: TabHandle,
      ctx: TabViewContext
    ): FileTabResource {
      const taskCtx = ctx as TaskTabContext;
      // Identity resolution happens here at the edge (spec §10): the tab path
      // is absolute after onBeforeOpen (workspace-resolved when it was
      // relative), and the task's workspace binding carries the host (local
      // vs. ssh connection) — including for paths outside the workspace root.
      const path = entry.state.path;
      const connectionId = taskCtx.getRemoteConnectionId?.();
      let ref: HostFileRef | null = null;
      try {
        ref = hostFileRefFromNativePath(path, connectionId);
      } catch {
        ref = null;
      }
      const inWorkspace = isWithinWorkspace(taskCtx.workspacePath, path);
      const releaseLanguage =
        ref && taskCtx.workspacePath
          ? registerLanguageContext(
              ref,
              hostFileRefFromNativePath(taskCtx.workspacePath, connectionId),
              { projectId: taskCtx.projectId, taskId: taskCtx.taskId }
            )
          : undefined;
      const resource = new FileTabResource(entry.state, {
        ref,
        handle,
        inWorkspace,
        displayPath: displayPathFor(path, inWorkspace, connectionId),
      });
      if (releaseLanguage) languageContexts.set(resource, releaseLanguage);
      return resource;
    },

    dispose(_entry: TabEntry<FilePayload>, resource: FileTabResource): void {
      languageContexts.get(resource)?.();
      languageContexts.delete(resource);
      resource.dispose();
    },

    async onBeforeClose(
      entry: TabEntry<FilePayload>,
      resource: FileTabResource,
      ctx: TabViewContext
    ): Promise<boolean> {
      const fileEntry = resource.entry;
      if (!fileEntry?.dirty) return true;
      const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(
        (ctx as TaskTabContext).projectId
      );
      if (liveActionDisabledReason) {
        toast.error('Unsaved file kept open', { description: liveActionDisabledReason });
        return false;
      }

      const fileName = entry.state.path.split('/').pop() ?? entry.state.path;
      const unsavedOutcome = await openModal('unsavedChangesModal', { fileName });
      if (!unsavedOutcome.success) return false;
      if (unsavedOutcome.data === 'discard') {
        openFileStore.reloadFromDisk(fileEntry);
        return true;
      }

      try {
        const saved = await openFileStore.save(fileEntry);
        if (saved.success) return true;
        if (saved.error.type !== 'conflict') return false;

        const conflictOutcome = await openModal('conflictDialog', {
          filePath: entry.state.path,
        });
        if (!conflictOutcome.success) return false;
        if (conflictOutcome.data) {
          openFileStore.reloadFromDisk(fileEntry);
          return true;
        }

        const overwritten = await openFileStore.save(fileEntry, { overwrite: true });
        return overwritten.success;
      } catch {
        return false;
      }
    },

    TabBarItem: FileTabBarItem,
    TabBarItemDragPreview: FileTabBarItemDragPreview,
    TabContent: FileTabContent,
  });

function isWithinWorkspace(workspacePath: string | undefined, path: string): boolean {
  if (!workspacePath) return false;
  try {
    relativePathWithin(hostPathFromNative(workspacePath), hostPathFromNative(path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Files with no containing workspace root display an absolute path,
 * host-prefixed when the task runs on a remote host (spec §5).
 */
function displayPathFor(
  path: string,
  inWorkspace: boolean,
  connectionId: string | undefined
): string {
  if (inWorkspace || !connectionId) return path;
  const machine = getMachinesStore().connections.find((config) => config.id === connectionId);
  return `${machine?.name ?? connectionId}:${path}`;
}
