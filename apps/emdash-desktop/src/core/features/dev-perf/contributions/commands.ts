import { defineCommand } from '@core/primitives/commands/api';

export const devProcessPanelCommand = defineCommand({
  id: 'devPerf.processPanel',
  title: '打开 Agent 运行监控',
  description: '查看 Emdash 启动的 Agent 及其他进程的实时 CPU 和内存占用',
  category: '开发者',
  icon: 'activity',
});

export const devPerfCaptureTraceCommand = defineCommand({
  id: 'devPerf.captureTrace',
  title: '记录性能跟踪',
  description: '记录 10 秒性能跟踪并保存到文件',
  category: '开发者',
  icon: 'gauge',
});

export const DEV_PERF_COMMAND_DEFS = [devProcessPanelCommand, devPerfCaptureTraceCommand] as const;
