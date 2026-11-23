import { Button, Input, toast } from '@emdash/ui/react/primitives';
import { useState } from 'react';
import { getCoordinationClient } from '../api/browser/client';
import type { Coordinator, TakeoverPreview } from '../api/types';

export function TakeOverTaskForm({ record }: { record: Coordinator }) {
  const [taskId, setTaskId] = useState('');
  const [preview, setPreview] = useState<TakeoverPreview>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mb-4 max-w-lg space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void getCoordinationClient()
          .then((client) => client.inspectTask({ id: record.id, taskId: taskId.trim() }))
          .then(setPreview)
          .catch((error) => toast.error('无法检查任务', { description: String(error) }))
          .finally(() => setBusy(false));
      }}
    >
      <p className="text-sm">接管已有独立 Task</p>
      <div className="flex gap-2">
        <Input
          data-testid="takeover-task-id"
          aria-label="要接管的 Task ID"
          value={taskId}
          placeholder="Task ID（任务标识）"
          onChange={(event) => {
            setTaskId(event.target.value);
            setPreview(undefined);
          }}
        />
        <Button data-testid="inspect-task-takeover" type="submit" disabled={busy || !taskId.trim()}>
          检查任务
        </Button>
      </div>
      {preview && (
        <div className="space-y-2 rounded border border-border p-3 text-sm">
          <p>{preview.name}</p>
          <p>当前所属工作区：{preview.ownerName ?? '尚无主任务工作区'}</p>
          {preview.ownerId === record.id ? (
            <p>这个 Task 已属于当前主任务工作区。</p>
          ) : (
            <>
              <p>
                接管后沿用原 Task、branch、worktree 和运行中的 Agent；结果与待处理通知会转移到这里。
              </p>
              <Button
                type="button"
                data-testid="confirm-task-takeover"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void getCoordinationClient()
                    .then((client) =>
                      client.takeOverTask({
                        id: record.id,
                        taskId: preview.taskId,
                        expectedOwner: preview.ownerId,
                      })
                    )
                    .then(() => {
                      setPreview(undefined);
                      setTaskId('');
                      toast.success('Task 归属已更新');
                    })
                    .catch(async (error) => {
                      toast.error('无法接管任务', { description: String(error) });
                      try {
                        setPreview(
                          await (
                            await getCoordinationClient()
                          ).inspectTask({
                            id: record.id,
                            taskId: preview.taskId,
                          })
                        );
                      } catch {
                        setPreview(undefined);
                      }
                    })
                    .finally(() => setBusy(false));
                }}
              >
                接管任务
              </Button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
