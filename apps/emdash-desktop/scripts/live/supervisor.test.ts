import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultLivePaths,
  fulfillLiveBackupRequest,
  inspectLiveSource,
  liveBackupRequestPath,
  readLiveState,
  signalLiveChildGroup,
  type LiveSupervisorState,
  waitForLiveChildGroupExit,
  writeLiveState,
} from './supervisor';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'emdash-live-supervisor-'));
  git(directory, 'init', '-b', 'mac-live');
  git(directory, 'config', 'user.name', 'Emdash Test');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(directory, 'README.md'), 'live\n');
  git(directory, 'add', 'README.md');
  git(directory, 'commit', '-m', 'initial');
  return directory;
}

describe('live supervisor state', () => {
  it('records the exact branch, commit and dirty state', () => {
    const directory = repository();
    const clean = inspectLiveSource(directory);
    expect(clean).toMatchObject({
      sourcePath: directory,
      branch: 'mac-live',
      runningCommit: git(directory, 'rev-parse', 'HEAD'),
      dirty: false,
    });

    writeFileSync(join(directory, 'README.md'), 'changed\n');
    expect(inspectLiveSource(directory).dirty).toBe(true);
  });

  it('writes state atomically with private file permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'emdash-live-state-'));
    const statePath = join(directory, 'nested', 'state.json');
    const state: LiveSupervisorState = {
      version: 1,
      sourcePath: '/repo',
      branch: 'mac-live',
      runningCommit: 'a'.repeat(40),
      dirty: false,
      status: 'running',
      supervisorPid: 123,
      startedAt: 1,
      updatedAt: 2,
    };
    writeLiveState(statePath, state);
    expect(readLiveState(statePath)).toEqual(state);
    expect(readFileSync(statePath, 'utf8')).toContain('"runningCommit"');
  });

  it('keeps the live profile separate from supervisor recovery state', () => {
    const paths = defaultLivePaths('/Users/tester');
    expect(paths.profilePath).toBe('/Users/tester/Library/Application Support/emdash-live');
    expect(paths.statePath).toBe(
      '/Users/tester/Library/Application Support/emdash-live-supervisor/state.json'
    );
    expect(dirname(paths.statePath)).not.toBe(paths.profilePath);
  });

  it('supports isolated paths for end-to-end runs', () => {
    const paths = defaultLivePaths('/Users/tester', {
      EMDASH_LIVE_PROFILE_DIR: '/tmp/emdash-profile',
      EMDASH_LIVE_STATE_FILE: '/tmp/emdash-state.json',
      EMDASH_LOG_FILE: '/tmp/emdash.log',
    });
    expect(paths).toEqual({
      profilePath: '/tmp/emdash-profile',
      statePath: '/tmp/emdash-state.json',
      logPath: '/tmp/emdash.log',
    });
  });

  it('creates a stopped-profile backup with a manifest before restarting', () => {
    const directory = mkdtempSync(join(tmpdir(), 'emdash-live-backup-'));
    const profilePath = join(directory, 'profile');
    const statePath = join(directory, 'supervisor', 'state.json');
    mkdirSync(profilePath, { recursive: true });
    writeFileSync(join(profilePath, 'settings.json'), '{"language":"zh-CN"}\n');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      liveBackupRequestPath(statePath),
      JSON.stringify({ id: 'backup-1', requestedAt: 100 })
    );
    const destination = fulfillLiveBackupRequest(profilePath, statePath, 'abc123');
    expect(readFileSync(join(destination!, 'profile', 'settings.json'), 'utf8')).toContain('zh-CN');
    expect(readFileSync(join(destination!, 'manifest.json'), 'utf8')).toContain('abc123');
    expect(existsSync(liveBackupRequestPath(statePath))).toBe(false);
  });

  it('signals the whole live runtime process group', () => {
    const signal = vi.fn();
    const directKill = vi.fn(() => true);
    signalLiveChildGroup({ pid: 4321, kill: directKill }, 'SIGTERM', signal);
    expect(signal).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(directKill).not.toHaveBeenCalled();
  });

  it('falls back to the direct child when its process group is already gone', () => {
    const missing = Object.assign(new Error('gone'), { code: 'ESRCH' });
    const directKill = vi.fn(() => true);
    signalLiveChildGroup(
      { pid: 4321, kill: directKill },
      'SIGTERM',
      vi.fn(() => {
        throw missing;
      })
    );
    expect(directKill).toHaveBeenCalledWith('SIGTERM');
  });

  it('accepts Darwin EPERM after a detached group leader exits', async () => {
    const inaccessible = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    const signal = vi.fn(() => {
      throw inaccessible;
    });
    await expect(waitForLiveChildGroupExit(4321, signal)).resolves.toBeUndefined();
    expect(signal).toHaveBeenCalledWith(-4321, 0);
  });
});
