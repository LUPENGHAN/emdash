import { hostRefEquals } from '@emdash/core/primitives/host/api';
import { Button, Input } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { openFileInTaskEditor } from '@core/features/editor/api/browser/open-file-in-file-editor';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { EditorFileTree } from '@core/features/editor/contributions/browser/editor-file-tree';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { taskTabView } from '@core/features/workbench/api/browser/task-tab-registry';
import { relativePathWithin } from '@core/primitives/desktop-runtime/api';
import { getCoordinationClient } from '../api/browser/client';
import { documentPathSchema } from '../api/documents';
import type { Coordinator } from '../api/types';
import { CoordinatorDocumentPush } from './coordinator-document-push';

export const CoordinatorDocumentsPanel = observer(function CoordinatorDocumentsPanel({
  record,
  children,
}: {
  record: Coordinator;
  children: ReactNode;
}) {
  const composition = useTaskComposition();
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState('');
  const [lastCommit, setLastCommit] = useState<string>();
  const activeFile =
    composition.paneLayout.focusedPane.activeResourceOfKind<FileTabResource>('file');
  const workspace = useQuery({
    queryKey: ['coordinator-documents', record.id],
    queryFn: async () => (await getCoordinationClient()).documentWorkspace({ id: record.id }),
  });
  const create = async () => {
    if (saving) return;
    const parsed = documentPathSchema.safeParse(path);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await (await getCoordinationClient()).createDocument({ id: record.id, path: parsed.data });
      await openFileInTaskEditor(record.projectId, record.taskId, parsed.data);
      composition.revealWorkspaceFile(parsed.data);
      setPath('');
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };
  let activePath: string | undefined;
  if (
    activeFile?.ref &&
    workspace.data &&
    hostRefEquals(activeFile.ref.host, workspace.data.root.host)
  ) {
    try {
      const path = relativePathWithin(workspace.data.root.path, activeFile.ref.path);
      if (documentPathSchema.safeParse(path).success) activePath = path;
    } catch {
      /* Outside-workspace editor tabs cannot be committed as documents. */
    }
  }
  const commit = async () => {
    if (saving || !activePath || !activeFile || !workspace.data) return;
    const revision = workspace.data.revision;
    setSaving(true);
    setError(undefined);
    setLastCommit(undefined);
    try {
      await composition.editorView.saveFile(activeFile.path);
      if (activeFile.isDirty || activeFile.contentStatus.kind !== 'ready')
        throw new Error('Resolve unsaved changes before committing this document.');
      const result = await (
        await getCoordinationClient()
      ).commitDocuments({
        id: record.id,
        paths: [activePath],
        message,
        expectedRevision: revision,
      });
      setLastCommit(result.hash);
      setMessage('');
      await workspace.refetch();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };
  if (workspace.error)
    return (
      <div className="space-y-3 p-4" role="alert">
        <p>{String(workspace.error)}</p>
        <Button variant="secondary" onClick={() => void workspace.refetch()}>
          Retry documents
        </Button>
      </div>
    );
  if (!workspace.data) return <p className="p-4">Loading management documents…</p>;
  const hasFile = !!composition.paneLayout.focusedPane.activeResourceOfKind('file');
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="coordinator-documents-panel">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <p className="text-xs text-foreground-muted">
          Management documents · {workspace.data.branch}
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Input
            aria-label="Document path"
            placeholder="plan.md"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <Button type="submit" disabled={saving || !path.trim()}>
            Create document
          </Button>
        </form>
        {activePath && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void commit();
            }}
          >
            <Input
              aria-label="Document commit message"
              placeholder="Commit message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={
                saving ||
                !message.trim() ||
                activeFile?.readOnly ||
                activeFile?.contentStatus.kind !== 'ready'
              }
              title={activePath}
            >
              Commit open document
            </Button>
          </form>
        )}
        {lastCommit && (
          <p
            role="status"
            data-testid="coordinator-document-commit"
            className="text-xs text-foreground-muted"
          >
            Committed document · <code>{lastCommit}</code>
          </p>
        )}
        <CoordinatorDocumentPush
          disabled={saving}
          record={record}
          revision={workspace.data.revision}
          refresh={() => workspace.refetch()}
        />
        {error && (
          <p role="alert" className="text-sm text-foreground-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {hasFile ? (
          children
        ) : (
          <taskTabView.TabLayoutProvider layout={composition.paneLayout}>
            <div className="flex h-full min-h-0">
              <div className="w-72 shrink-0 overflow-auto border-r border-border">
                <EditorFileTree />
              </div>
              <p className="p-6 text-sm text-foreground-muted">
                Choose a document in the file tree, or create one above. Parent folders can be
                created in the file tree.
              </p>
            </div>
          </taskTabView.TabLayoutProvider>
        )}
      </div>
    </div>
  );
});
