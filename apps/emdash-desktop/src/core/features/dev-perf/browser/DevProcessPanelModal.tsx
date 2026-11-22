import { Button, Switch } from '@emdash/ui/react/primitives';
import React, { useEffect, useState } from 'react';
import { defineModal } from '@core/primitives/modals/react';
import { captureDevPerfTrace } from '../api/browser/capture-trace';
import { getDevPerfClient } from '../api/browser/client';
import type { DevPerfProcess } from '../api/contract';
import { agentProcessLabel, agentProcesses, agentRootProcesses } from './agent-process';
import { createProcessPoller } from './process-poller';

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function totalOf(processes: DevPerfProcess[], pick: (p: DevPerfProcess) => number): number {
  return processes.reduce((sum, processInfo) => sum + pick(processInfo), 0);
}

type TraceState =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string };

export function DevProcessPanelModal() {
  const [processes, setProcesses] = useState<DevPerfProcess[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [showAllProcesses, setShowAllProcesses] = useState(false);
  const [spawnLogging, setSpawnLogging] = useState(false);
  const [trace, setTrace] = useState<TraceState>({ kind: 'idle' });

  // Poll only while the panel is mounted; unmount stops all polling.
  useEffect(() => {
    const poller = createProcessPoller({
      fetchSnapshot: async () => (await getDevPerfClient()).processSnapshot(),
      onSnapshot(snapshot) {
        setSupported(snapshot.supported);
        setProcesses(snapshot.processes);
      },
    });
    return () => poller.stop();
  }, []);

  useEffect(() => {
    void getDevPerfClient().then(async (client) => {
      const { enabled } = await client.getVerboseSpawnLogging();
      setSpawnLogging(enabled);
    });
  }, []);

  const handleCaptureTrace = async () => {
    setTrace({ kind: 'recording' });
    const outcome = await captureDevPerfTrace();
    setTrace(
      outcome.ok
        ? { kind: 'done', path: outcome.path }
        : { kind: 'error', message: outcome.message }
    );
  };

  const handleSpawnLoggingChange = async (enabled: boolean) => {
    setSpawnLogging(enabled);
    const client = await getDevPerfClient();
    await client.setVerboseSpawnLogging({ enabled });
  };

  const detectedAgents = processes ? agentProcesses(processes) : [];
  const agentRoots = processes ? agentRootProcesses(processes) : [];
  const visibleProcesses = showAllProcesses ? (processes ?? []) : detectedAgents;

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Agent 运行监控</h2>
        <p className="mt-1 text-xs text-foreground-muted">
          每秒刷新这台电脑上由 Emdash 启动的进程。默认只显示可识别的 Agent 相关进程。
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <div className="text-xs">
          <span className="font-medium">运行中的 Agent {agentRoots.length} 个</span>
          <span className="ml-2 text-foreground-muted">相关进程 {detectedAgents.length} 个</span>
          {processes && detectedAgents.length > 0 ? (
            <span className="ml-2 text-foreground-muted">
              CPU {totalOf(detectedAgents, ({ cpuPercent }) => cpuPercent).toFixed(1)}% · 内存{' '}
              {formatMemory(totalOf(detectedAgents, ({ rssBytes }) => rssBytes))}
            </span>
          ) : null}
        </div>
        <label className="flex min-h-6 items-center gap-2 text-xs">
          <Switch checked={showAllProcesses} onCheckedChange={setShowAllProcesses} />
          显示全部 Emdash 进程
        </label>
      </div>

      {!supported && (
        <p className="text-muted-foreground text-xs">
          当前系统不支持进程快照。Windows 版本需要使用会话状态监控。
        </p>
      )}

      {processes === null ? (
        <p className="text-muted-foreground text-xs">正在读取运行中的进程…</p>
      ) : visibleProcesses.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-foreground-muted">
          当前没有检测到运行中的 Agent 相关进程。
        </div>
      ) : (
        <div
          className="max-h-[55dvh] max-w-full overflow-auto overscroll-contain rounded border"
          role="region"
          aria-label="运行中的 Emdash 进程"
          tabIndex={0}
        >
          <table className="w-full text-left font-mono text-xs">
            <caption className="sr-only">
              {showAllProcesses ? '全部 Emdash 进程' : '运行中的 Agent 相关进程'}
            </caption>
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  类型
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  进程命令
                </th>
                <th scope="col" className="w-16 px-2 py-1 text-right font-medium">
                  PID
                </th>
                <th scope="col" className="w-16 px-2 py-1 text-right font-medium">
                  CPU %
                </th>
                <th scope="col" className="w-24 px-2 py-1 text-right font-medium">
                  内存
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleProcesses.map((processInfo) => (
                <tr key={processInfo.pid} className="border-t">
                  <th scope="row" className="px-2 py-0.5 font-medium whitespace-nowrap">
                    {agentProcessLabel(processInfo.command) ?? 'Emdash'}
                  </th>
                  <td
                    className="max-w-96 truncate px-2 py-0.5"
                    style={{ paddingLeft: `${8 + processInfo.depth * 16}px` }}
                    title={processInfo.command}
                  >
                    {processInfo.command}
                  </td>
                  <td className="px-2 py-0.5 text-right">{processInfo.pid}</td>
                  <td className="px-2 py-0.5 text-right">{processInfo.cpuPercent.toFixed(1)}</td>
                  <td className="px-2 py-0.5 text-right">{formatMemory(processInfo.rssBytes)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 border-t">
                <th scope="row" colSpan={2} className="px-2 py-1 text-left font-medium">
                  合计（{visibleProcesses.length} 个进程）
                </th>
                <td />
                <td className="px-2 py-1 text-right font-medium">
                  {totalOf(visibleProcesses, ({ cpuPercent }) => cpuPercent).toFixed(1)}
                </td>
                <td className="px-2 py-1 text-right font-medium">
                  {formatMemory(totalOf(visibleProcesses, ({ rssBytes }) => rssBytes))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <details className="rounded-md border border-border px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium select-none">诊断工具</summary>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleCaptureTrace()}
            disabled={trace.kind === 'recording'}
          >
            {trace.kind === 'recording' ? '正在记录（10 秒）…' : '记录性能跟踪（10 秒）'}
          </Button>
          <label className="flex min-h-6 items-center gap-2">
            <Switch
              checked={spawnLogging}
              onCheckedChange={(checked) => void handleSpawnLoggingChange(checked)}
            />
            记录详细的进程启动日志
          </label>
        </div>
        {trace.kind === 'done' && (
          <p className="mt-2 font-mono text-[11px] break-all text-foreground-muted select-text">
            跟踪文件：{trace.path}
          </p>
        )}
        {trace.kind === 'error' && (
          <p className="text-destructive mt-2 text-xs">记录失败：{trace.message}</p>
        )}
      </details>
    </div>
  );
}

export const devProcessPanelModal = defineModal<void>()({
  id: 'devProcessPanelModal',
  component: DevProcessPanelModal,
  size: 'lg',
});
