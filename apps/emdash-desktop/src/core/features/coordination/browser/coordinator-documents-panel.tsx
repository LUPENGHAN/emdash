import { Button, Input } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { openFileInTaskEditor } from '@core/features/editor/api/browser/open-file-in-file-editor';
import { EditorFileTree } from '@core/features/editor/contributions/browser/editor-file-tree';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { taskTabView } from '@core/features/workbench/api/browser/task-tab-registry';
import { getCoordinationClient } from '../api/browser/client';
import { documentPathSchema } from '../api/documents';
import type { Coordinator } from '../api/types';

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
