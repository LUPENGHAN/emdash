import { readFile } from 'node:fs/promises';
import { liveRuntimeStateSchema } from '@core/primitives/desktop-host/api/host-contract';

function stateFile(): string | undefined {
  return process.env.EMDASH_LIVE_STATE_FILE;
}

export async function getLiveRuntimeState() {
  const path = stateFile();
  if (process.env.VITE_BUILD !== 'live' || !path) return { available: false };
  try {
    const state = liveRuntimeStateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    return { available: true, state };
  } catch {
    return { available: true };
  }
}

export async function controlLiveRuntime(input: { action: 'restart' | 'mark-good' }) {
  const current = await getLiveRuntimeState();
  const state = current.state;
  if (!state) return { success: false, error: '实时开发版 Supervisor 尚未就绪。' };
  try {
    process.kill(state.supervisorPid, 0);
    if (input.action === 'mark-good') {
      if (state.dirty) return { success: false, error: '工作区有未提交修改，不能标记为可用版本。' };
      if (state.status !== 'running')
        return { success: false, error: '实时开发版当前不是稳定运行状态。' };
      process.kill(state.supervisorPid, 'SIGUSR1');
    } else {
      process.kill(state.supervisorPid, 'SIGUSR2');
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
