import { Button } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getCoordinationClient } from '../api/browser/client';

export function TaskStartupStatus({
  coordinatorId,
  taskId,
  cancelled,
}: {
  coordinatorId: string;
  taskId: string;
  cancelled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const status = useQuery({
    queryKey: ['coordinator-delegation-status', coordinatorId, taskId],
    queryFn: async () =>
      (await getCoordinationClient()).delegationStatus({ id: coordinatorId, taskId }),
  });
  const retry = async () => {
    if (busy || cancelled) return;
    setBusy(true);
    setError(undefined);
    try {
      await (await getCoordinationClient()).retryTask({ id: coordinatorId, taskId });
    } catch (cause) {
      setError(String(cause));
    } finally {
      await status.refetch();
      setBusy(false);
    }
  };
  if (!status.data?.error && !status.error && !error) return null;
  return (
    <div className="mt-2 space-y-2 text-sm" data-testid="task-startup-status" data-task-id={taskId}>
      {status.data?.error && (
        <div className="space-y-1">
          <p role="alert">Task startup failed. Fix the Agent or host configuration, then retry.</p>
          <details>
            <summary>Failure details</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{status.data.error}</pre>
          </details>
        </div>
      )}
      {(error || status.error) && <p role="alert">{error ?? String(status.error)}</p>}
      {status.data?.canRetry && !cancelled && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          data-testid="retry-task-startup"
          onClick={() => void retry()}
        >
          Retry task startup
        </Button>
      )}
    </div>
  );
}
