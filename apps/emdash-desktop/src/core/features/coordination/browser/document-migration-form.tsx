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
      <p>将选中的工作区文档迁移到独立 Git 工作树。</p>
      <p className="text-xs text-foreground-muted">
        原文件、分支和对话都会保留。仅选择由该主任务工作区管理的方案与决策；产品文档仍跟随代码
        Task。如果存储已断开，请先重新连接再复制。
      </p>
      {pending ? (
        <>
          <p className="text-sm">
            迁移状态：{migration.phase} · 已复制 {migration.copied.length}/{migration.files.length}{' '}
            个文件
          </p>
          <details>
            <summary>已选文档版本</summary>
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
              复制、验证并启用文档
            </Button>
            <Button
              disabled={busy}
              variant="secondary"
              data-testid="cancel-document-migration"
              onClick={() => void perform('cancel')}
            >
              保留原存储
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
              文档迁移完成，原存储已保留。
            </p>
          )}
          <Select.Root value={projectId} onValueChange={(value) => setProjectId(value ?? '')}>
            <Select.Trigger
              aria-label="迁移目标项目"
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
            aria-label="工作区文档路径"
            data-testid="migration-document-paths"
            placeholder={'plans/decision.md\nnotes/acceptance.md'}
            value={paths}
            onChange={(event) => setPaths(event.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-foreground-muted">
            每行填写一个相对路径。每次最多迁移 100 个文本文档、共 16 MiB；复制前会先展示已保存的
            版本。
          </p>
          <Button
            disabled={busy || !projectId || !paths.trim()}
            data-testid="prepare-document-migration"
            onClick={() => void perform('prepare')}
          >
            准备所选文档
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
          已保留 {record.documentStorageHistory.length} 个文档工作区，未删除任何原文件。
        </p>
      )}
    </div>
  );
});
