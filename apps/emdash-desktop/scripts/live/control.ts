import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLivePaths, liveBackupRequestPath, readLiveState } from './supervisor';

export type LiveControlCommand = 'status' | 'restart' | 'mark-good' | 'backup';

export function runLiveControl(command: LiveControlCommand): void {
  const { statePath } = defaultLivePaths();
  const state = readLiveState(statePath);
  if (!state) throw new Error('实时开发版尚未启动。');
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  if (!Number.isSafeInteger(state.supervisorPid)) throw new Error('实时开发版 Supervisor 未运行。');
  try {
    process.kill(state.supervisorPid, 0);
  } catch {
    throw new Error('实时开发版 Supervisor 未运行。');
  }
  if (command === 'mark-good') {
    if (state.dirty) throw new Error('工作区有未提交修改，不能标记为可用版本。');
    if (state.status !== 'running') throw new Error('实时开发版尚未通过运行检查。');
    process.kill(state.supervisorPid, 'SIGUSR1');
    return;
  }
  if (command === 'backup') {
    const requestPath = liveBackupRequestPath(statePath);
    if (existsSync(requestPath)) throw new Error('已有备份请求正在处理。');
    mkdirSync(dirname(requestPath), { recursive: true });
    writeFileSync(
      requestPath,
      `${JSON.stringify({ id: `${Date.now()}-${randomUUID().slice(0, 8)}`, requestedAt: Date.now() })}\n`,
      { mode: 0o600 }
    );
    process.kill(state.supervisorPid, 'SIGUSR2');
    return;
  }
  process.kill(state.supervisorPid, 'SIGUSR2');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] as LiveControlCommand | undefined;
  if (!command || !['status', 'restart', 'mark-good', 'backup'].includes(command)) {
    console.error(
      '用法：pnpm live:status | pnpm live:restart | pnpm live:mark-good | pnpm live:backup'
    );
    process.exitCode = 2;
  } else {
    try {
      runLiveControl(command);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
