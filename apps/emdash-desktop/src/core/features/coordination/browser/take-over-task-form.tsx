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
          .catch((error) => toast.error('Could not inspect task', { description: String(error) }))
          .finally(() => setBusy(false));
      }}
    >
      <p className="text-sm">Take over an existing task</p>
      <div className="flex gap-2">
        <Input
          data-testid="takeover-task-id"
          aria-label="Task ID to take over"
          value={taskId}
          placeholder="Task ID"
          onChange={(event) => {
            setTaskId(event.target.value);
            setPreview(undefined);
          }}
        />
        <Button data-testid="inspect-task-takeover" type="submit" disabled={busy || !taskId.trim()}>
          Inspect task
        </Button>
      </div>
      {preview && (
        <div className="space-y-2 rounded border border-border p-3 text-sm">
          <p>{preview.name}</p>
          <p>Managed by: {preview.ownerName ?? 'No main agent'}</p>
          {preview.ownerId === record.id ? (
            <p>This main agent already manages the task.</p>
          ) : (
            <>
              <p>
                The task keeps its branch and running agent. Results and pending notifications move
                here.
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
                      toast.success('Task ownership updated');
                    })
                    .catch((error) =>
                      toast.error('Could not take over task', { description: String(error) })
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Take over task
              </Button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
