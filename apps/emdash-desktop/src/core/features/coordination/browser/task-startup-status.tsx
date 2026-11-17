import { Button } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DelegationSelectionSnapshot } from '@core/features/agent-control/api/selection-snapshot';
import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getCoordinationClient } from '../api/browser/client';

const sourceLabels: Record<DelegationSelectionSnapshot['sources']['agent'], string> = {
  request: 'Specified for this task',
  'main-default': 'Main agent delegation default',
  'agent-default': 'Agent setting',
  'adapter-default': 'Model / agent default',
  caller: 'Calling agent',
};

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
  const { data: agents } = useAgentMetadata();
  const { value: providers } = useAppSettingsKey('modelProviders');
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
  const snapshot = status.data?.selectionSnapshot;
  const selection = snapshot?.values;
  const providerName = (id: string) =>
    providers?.providers.find((provider) => provider.id === id)?.name ?? id;
  if (!snapshot && !status.data?.error && !status.error && !error) return null;
  return (
    <div className="mt-2 space-y-2 text-sm" data-testid="task-startup-status" data-task-id={taskId}>
      {snapshot && selection ? (
        <details data-testid="task-execution-configuration">
          <summary>Saved execution configuration</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {(
              [
                [
                  'Agent',
                  agents?.find((agent) => agent.id === selection.agent)?.name ?? selection.agent,
                  snapshot.sources.agent,
                ],
                [
                  'Interface',
                  selection.transport === 'acp' ? 'Chat' : 'Terminal',
                  snapshot.sources.transport,
                ],
                [
                  'Access method',
                  selection.modelSource === 'gateway:models'
                    ? 'Gateway'
                    : selection.modelSource
                      ? providerName(selection.modelSource)
                      : 'Agent login / configuration',
                  snapshot.sources.modelSource,
                ],
                [
                  'Model supplier',
                  selection.supplierId
                    ? providerName(selection.supplierId)
                    : 'Model route / default',
                  snapshot.sources.supplierId,
                ],
                ['Model', selection.model ?? 'Model / agent default', snapshot.sources.model],
                ['Effort', selection.effort ?? 'Model / agent default', snapshot.sources.effort],
              ] as const
            ).map(([label, value, source]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd className="break-all">
                  <span>{value}</span> · <span>{sourceLabels[source]}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-foreground-muted">
            Saved when this task was prepared. Waiting and startup retries keep these selections.
          </p>
        </details>
      ) : null}
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
