import { Button } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getSourceControlClient } from '@core/features/source-control/api/browser/client';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';

/** Saved task PR requests are independent of a worker's submitted result version. */
export function TaskPullRequestStatus({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const key = ['task-pull-requests', taskId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await getSourceControlClient()).taskPullRequests.list({ taskId }),
  });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const retry = async (requestId: string) => {
    setBusy(requestId);
    setError(undefined);
    try {
      await (
        await getSourceControlClient()
      ).taskPullRequests.run({ taskId, requestId }, { timeoutMs: 0 });
    } catch (cause) {
      setError(String(cause));
    } finally {
      await queryClient.invalidateQueries({ queryKey: key });
      setBusy(undefined);
    }
  };
  if (query.error)
    return (
      <p className="mt-2 text-xs" role="alert">
        Could not read task PR requests: {String(query.error)}
      </p>
    );
  if (!query.data?.length) return null;
  return (
    <div className="mt-2 space-y-2" data-testid="task-pr-status">
      {query.data.map((request) => (
        <details key={request.requestId} className="rounded border border-border p-2 text-sm">
          <summary>
            {request.plan.title} · PR {request.phase}
          </summary>
          <p>
            {request.plan.headRepositoryUrl} · {request.plan.sourceRef.slice('refs/heads/'.length)}{' '}
            · {request.plan.oid.slice(0, 12)}
          </p>
          <p>
            {request.plan.push === false
              ? 'Existing remote commit; no push'
              : `Push remote: ${request.plan.pushTarget.remote}`}
          </p>
          <p>
            Target: {request.plan.repositoryUrl} · {request.plan.base}
          </p>
          {request.result && (
            <Button
              variant="secondary"
              onClick={() => {
                if (request.result) void openExternal(request.result.url);
              }}
            >
              {request.result.url}
            </Button>
          )}
          {request.error && <p role="alert">{request.error}</p>}
          {request.phase !== 'complete' && (
            <Button
              data-testid="retry-task-pr"
              disabled={!!busy}
              onClick={() => void retry(request.requestId)}
            >
              {busy === request.requestId ? 'Continuing PR request…' : 'Continue saved PR request'}
            </Button>
          )}
        </details>
      ))}
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
