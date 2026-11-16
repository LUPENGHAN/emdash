import { Button, Select, Textarea } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getCoordinationClient } from '../api/browser/client';
import type { Coordinator } from '../api/types';

export const DocumentMigrationForm = observer(function DocumentMigrationForm({
  record,
}: {
  record: Coordinator;
}) {
  const [projectId, setProjectId] = useState(record.documentStorage?.projectId ?? record.projectId);
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const queryClient = useQueryClient();
  const migration = record.documentMigration;
  const pending = migration && !['complete', 'cancelled'].includes(migration.phase);
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt
  );
  const perform = async (action: 'prepare' | 'run' | 'cancel') => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const client = await getCoordinationClient();
      if (action === 'prepare') {
        await client.prepareDocumentMigration({
          id: record.id,
          requestId: crypto.randomUUID(),
          projectId,
          paths: paths
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean),
        });
      } else if (migration) {
        if (action === 'run')
          await client.runDocumentMigration({ id: record.id, migrationId: migration.id });
        else await client.cancelDocumentMigration({ id: record.id, migrationId: migration.id });
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['coordinator', record.taskId] });
      await queryClient.invalidateQueries({ queryKey: ['coordinator-documents', record.id] });
      await queryClient.invalidateQueries({
        queryKey: ['coordinator-document-remotes', record.id],
      });
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 p-3" data-testid="document-migration-form">
      <p>Move selected management documents to an independent Git worktree.</p>
      <p className="text-xs text-foreground-muted">
        Original files, branches and conversations are preserved. Select only plans and decisions
        managed by this main agent; product documentation stays with code tasks. If storage is
        disconnected, reconnect it before copying.
      </p>
      {pending ? (
        <>
          <p className="text-sm">
            Migration: {migration.phase} · {migration.copied.length}/{migration.files.length} files
            copied
          </p>
          <details>
            <summary>Selected document versions</summary>
            {migration.files.map((file) => (
              <div key={file.path} className="my-2 text-xs">
                <p>
                  {file.path} · {file.revision}
                </p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{file.content}</pre>
              </div>
            ))}
          </details>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              data-testid="run-document-migration"
              onClick={() => void perform('run')}
            >
              Copy, verify and use documents
            </Button>
            <Button
              disabled={busy}
              variant="secondary"
              data-testid="cancel-document-migration"
              onClick={() => void perform('cancel')}
            >
              Keep original storage
            </Button>
          </div>
          {migration.error && (
            <p role="alert" className="text-sm">
              {migration.error}
            </p>
          )}
        </>
      ) : (
        <>
          {migration?.phase === 'complete' && (
            <p role="status" data-testid="document-migration-complete">
              Document migration completed. Original storage is preserved.
            </p>
          )}
          <Select.Root value={projectId} onValueChange={(value) => setProjectId(value ?? '')}>
            <Select.Trigger
              aria-label="Migration destination project"
              data-testid="migration-destination-project"
              disabled={busy}
            >
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {projects.map((project) => (
                <Select.Item key={project.id} value={project.id}>
                  {project.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Textarea
            aria-label="Management document paths"
            data-testid="migration-document-paths"
            placeholder={'plans/decision.md\nnotes/acceptance.md'}
            value={paths}
            onChange={(event) => setPaths(event.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-foreground-muted">
            One relative file path per line. Up to 100 text documents and 16 MiB per migration. The
            next step shows the saved versions before copying.
          </p>
          <Button
            disabled={busy || !projectId || !paths.trim()}
            data-testid="prepare-document-migration"
            onClick={() => void perform('prepare')}
          >
            Prepare selected documents
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-foreground-destructive">
          {error}
        </p>
      )}
      {!!record.documentStorageHistory?.length && (
        <p className="text-xs text-foreground-muted">
          Preserved document workspaces: {record.documentStorageHistory.length}. No original files
          were deleted.
        </p>
      )}
    </div>
  );
});
