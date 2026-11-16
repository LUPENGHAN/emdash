import { Button, Select } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getCoordinationClient } from '../api/browser/client';
import type { Coordinator } from '../api/types';

export const DocumentStorageSetup = observer(function DocumentStorageSetup({
  record,
}: {
  record: Coordinator;
}) {
  const [projectId, setProjectId] = useState(record.documentStorage?.projectId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const queryClient = useQueryClient();
  const projects = Array.from(getProjectManagerStore().projects.values()).filter(
    (project) => !project.data?.archivedAt && project.id !== record.projectId
  );
  const configure = async () => {
    if (busy || !projectId) return;
    setBusy(true);
    setError(undefined);
    try {
      await (await getCoordinationClient()).createDocumentStorage({ id: record.id, projectId });
      await queryClient.invalidateQueries({ queryKey: ['coordinator', record.taskId] });
      await queryClient.invalidateQueries({ queryKey: ['coordinator-documents', record.id] });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (busy || !record.documentStorage) return;
    setBusy(true);
    setError(undefined);
    try {
      await (
        await getCoordinationClient()
      ).cancelDocumentStorageSetup({ id: record.id, taskId: record.documentStorage.taskId });
      await queryClient.invalidateQueries({ queryKey: ['coordinator', record.taskId] });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 p-4" data-testid="document-storage-setup">
      <p>Choose a Git repository to store this main agent's management documents.</p>
      <p className="text-sm text-foreground-muted">
        Documents use their own branch. Your conversation, directory files and code baseline stay in
        place.
      </p>
      <Select.Root value={projectId} onValueChange={(value) => setProjectId(value ?? '')}>
        <Select.Trigger
          aria-label="Document storage project"
          data-testid="document-storage-project"
          disabled={busy || !!record.documentStorage}
        >
          <Select.Value placeholder="Choose a Git repository" />
        </Select.Trigger>
        <Select.Content>
          {projects.map((project) => (
            <Select.Item key={project.id} value={project.id}>
              {project.name}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <Button
        disabled={busy || !projectId}
        data-testid="configure-document-storage"
        onClick={() => void configure()}
      >
        {record.documentStorage ? 'Retry document storage setup' : 'Use repository for documents'}
      </Button>
      {record.documentStorage && (
        <Button
          disabled={busy}
          variant="secondary"
          data-testid="cancel-document-storage-setup"
          onClick={() => void cancel()}
        >
          Cancel setup and choose another repository
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-foreground-destructive">
          {error}
        </p>
      )}
    </div>
  );
});
