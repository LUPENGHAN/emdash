import { Button } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DelegationSelectionSnapshot } from '@core/features/agent-control/api/selection-snapshot';
import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getCoordinationClient } from '../api/browser/client';

const sourceLabels: Record<DelegationSelectionSnapshot['sources']['agent'], string> = {
  request: '本次任务明确选择',
  'main-default': '已迁移的工作区偏好',
  'agent-default': '应用级 Agent 设置',
  'adapter-default': '模型或 Agent 默认值',
  caller: '调用方 Agent',
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
          <summary>已冻结的执行配置</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {(
              [
                [
                  '执行 Agent',
                  agents?.find((agent) => agent.id === selection.agent)?.name ?? selection.agent,
                  snapshot.sources.agent,
                ],
                [
                  '交互方式',
                  selection.transport === 'acp' ? '聊天' : '终端',
                  snapshot.sources.transport,
                ],
                [
                  '连接方式',
                  selection.modelSource === 'gateway:models'
                    ? 'Gateway'
                    : selection.modelSource
                      ? providerName(selection.modelSource)
                      : 'Agent 登录或自身配置',
                  snapshot.sources.modelSource,
                ],
                [
                  '模型供应方',
                  selection.supplierId ? providerName(selection.supplierId) : '模型路由或默认值',
                  snapshot.sources.supplierId,
                ],
                ['模型', selection.model ?? '模型或 Agent 默认值', snapshot.sources.model],
                ['思考强度', selection.effort ?? '模型或 Agent 默认值', snapshot.sources.effort],
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
            此配置在任务准备时冻结；等待和启动重试都会沿用，不受后续设置变化影响。
          </p>
        </details>
      ) : null}
      {status.data?.error && (
        <div className="space-y-1">
          <p role="alert">任务启动失败。请修复 Agent 或 Host 配置后重试。</p>
          <details>
            <summary>失败详情</summary>
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
          重试任务启动
        </Button>
      )}
    </div>
  );
}
