import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlLiveRuntime, getLiveRuntimeState } from './live-runtime';

const originalBuild = process.env.VITE_BUILD;
const originalStateFile = process.env.EMDASH_LIVE_STATE_FILE;

afterEach(() => {
  if (originalBuild === undefined) delete process.env.VITE_BUILD;
  else process.env.VITE_BUILD = originalBuild;
  if (originalStateFile === undefined) delete process.env.EMDASH_LIVE_STATE_FILE;
  else process.env.EMDASH_LIVE_STATE_FILE = originalStateFile;
  vi.restoreAllMocks();
});

function liveState(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'emdash-live-host-'));
  const path = join(directory, 'state.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      sourcePath: '/repo',
      branch: 'mac-live',
      runningCommit: 'a'.repeat(40),
      dirty: false,
      status: 'running',
      supervisorPid: 123,
      startedAt: 1,
      updatedAt: 2,
      ...overrides,
    })
  );
  process.env.VITE_BUILD = 'live';
  process.env.EMDASH_LIVE_STATE_FILE = path;
}

describe('live runtime host bridge', () => {
  it('is unavailable outside the source-running build', async () => {
    delete process.env.VITE_BUILD;
    expect(await getLiveRuntimeState()).toEqual({ available: false });
  });

  it('returns the supervisor state and requests a controlled restart', async () => {
    liveState();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(await getLiveRuntimeState()).toMatchObject({
      available: true,
      state: { branch: 'mac-live', status: 'running' },
    });
    expect(await controlLiveRuntime({ action: 'restart' })).toEqual({ success: true });
    expect(kill).toHaveBeenNthCalledWith(1, 123, 0);
    expect(kill).toHaveBeenNthCalledWith(2, 123, 'SIGUSR2');
  });

  it('refuses to mark a dirty revision as known-good', async () => {
    liveState({ dirty: true });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(await controlLiveRuntime({ action: 'mark-good' })).toEqual({
      success: false,
      error: '工作区有未提交修改，不能标记为可用版本。',
    });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
