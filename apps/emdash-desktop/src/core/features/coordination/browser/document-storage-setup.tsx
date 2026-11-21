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
      <p>选择一个 Git 仓库，用于保存这个主任务工作区的管理文档。</p>
      <p className="text-sm text-foreground-muted">
        文档使用独立分支；对话、目录文件和代码基线均保持原位。
      </p>
      <Select.Root value={projectId} onValueChange={(value) => setProjectId(value ?? '')}>
        <Select.Trigger
          aria-label="文档存储项目"
          data-testid="document-storage-project"
          disabled={busy || !!record.documentStorage}
        >
          <Select.Value placeholder="选择 Git 仓库" />
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
        {record.documentStorage ? '重试文档存储设置' : '使用此仓库保存文档'}
      </Button>
      {record.documentStorage && (
        <Button
          disabled={busy}
          variant="secondary"
          data-testid="cancel-document-storage-setup"
          onClick={() => void cancel()}
        >
          取消设置并选择其他仓库
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
