import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LiveRuntimeStatus =
  | 'starting'
  | 'running'
  | 'waiting_for_idle'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type LiveSupervisorState = {
  version: 1;
  sourcePath: string;
  branch: string;
  runningCommit: string;
  lastKnownGoodCommit?: string;
  pendingCommit?: string;
  dirty: boolean;
  status: LiveRuntimeStatus;
  childPid?: number;
  supervisorPid: number;
  startedAt: number;
  updatedAt: number;
  lastHealthCheck?: {
    commit: string;
    passed: boolean;
    checkedAt: number;
    failures: string[];
  };
  error?: string;
};

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

export function inspectLiveSource(
  repoRoot: string
): Pick<LiveSupervisorState, 'sourcePath' | 'branch' | 'runningCommit' | 'dirty'> {
  return {
    sourcePath: repoRoot,
    branch: git(repoRoot, ['branch', '--show-current']) || '(detached)',
    runningCommit: git(repoRoot, ['rev-parse', 'HEAD']),
    dirty: git(repoRoot, ['status', '--porcelain']).length > 0,
  };
}

export function writeLiveState(path: string, state: LiveSupervisorState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readLiveState(path: string): LiveSupervisorState | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LiveSupervisorState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function defaultLivePaths(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): {
  profilePath: string;
  statePath: string;
  logPath: string;
} {
  const applicationSupport = join(home, 'Library', 'Application Support');
  const supervisorPath = join(applicationSupport, 'emdash-live-supervisor');
  return {
    profilePath: env.EMDASH_LIVE_PROFILE_DIR || join(applicationSupport, 'emdash-live'),
    statePath: env.EMDASH_LIVE_STATE_FILE || join(supervisorPath, 'state.json'),
    logPath: env.EMDASH_LOG_FILE || join(supervisorPath, 'emdash.log'),
  };
}

export function liveBackupRequestPath(statePath: string): string {
  return `${statePath}.backup-request`;
}

export function fulfillLiveBackupRequest(
  profilePath: string,
  statePath: string,
  revision: string
): string | undefined {
  const requestPath = liveBackupRequestPath(statePath);
  if (!existsSync(requestPath)) return undefined;
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
    id: string;
    requestedAt: number;
  };
  if (!/^[a-zA-Z0-9._-]+$/.test(request.id)) throw new Error('备份请求 ID 无效。');
  const destination = join(dirname(statePath), 'backups', request.id);
  if (existsSync(destination)) throw new Error('同名备份已经存在。');
  mkdirSync(destination, { recursive: true });
  if (existsSync(profilePath))
    cpSync(profilePath, join(destination, 'profile'), { recursive: true });
  writeFileSync(
    join(destination, 'manifest.json'),
    `${JSON.stringify({ version: 1, id: request.id, revision, requestedAt: request.requestedAt, createdAt: Date.now() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  rmSync(requestPath);
  return destination;
}

export function startLiveChild(
  repoRoot: string,
  statePath: string,
  profilePath: string,
  logPath: string,
  source: ReturnType<typeof inspectLiveSource>
): ChildProcess {
  mkdirSync(profilePath, { recursive: true });
  const args = ['exec', 'electron-vite'];
  const remoteDebuggingPort = process.env.EMDASH_LIVE_REMOTE_DEBUGGING_PORT;
  if (remoteDebuggingPort) args.push('--remoteDebuggingPort', remoteDebuggingPort);
  // The default command keeps the renderer dev server hot without watching and
  // restarting the Electron main process. Main/runtime changes are applied only
  // through this supervisor's controlled restart path.
  return spawn('pnpm', args, {
    cwd: join(repoRoot, 'apps', 'emdash-desktop'),
    stdio: 'inherit',
    // Own the entire pnpm -> electron-vite -> Electron tree as one process
    // group. Killing only the pnpm wrapper leaves Electron orphaned and the
    // replacement instance then opens the same profile concurrently.
    detached: true,
    env: {
      ...process.env,
      // Coding-agent shells may set this to run Electron's bundled Node. The
      // desktop app itself must never inherit it.
      ELECTRON_RUN_AS_NODE: undefined,
      VITE_BUILD: 'live',
      VITE_LIVE_REVISION: source.runningCommit.slice(0, 12),
      VITE_LIVE_BRANCH: source.branch,
      VITE_LIVE_DIRTY: source.dirty ? '1' : '0',
      EMDASH_USER_DATA_DIR: profilePath,
      EMDASH_LIVE_STATE_FILE: statePath,
      // This is the only repository the Live app may use for self-development.
      // Packaged builds never receive this capability.
      EMDASH_LIVE_SOURCE_PATH: source.sourcePath,
      EMDASH_LOG_FILE: logPath,
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug',
    },
  });
}

type ProcessSignal = (pid: number, signal?: NodeJS.Signals | number) => void;

export function signalLiveChildGroup(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals,
  signalProcess: ProcessSignal = process.kill
): void {
  if (child.pid) {
    try {
      signalProcess(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

export async function waitForLiveChildGroupExit(
  pid: number | undefined,
  signalProcess: ProcessSignal = process.kill,
  timeoutMs = 5_000
): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      signalProcess(-pid, 0);
    } catch (error) {
      // Darwin can report EPERM for a detached group after its leader exits,
      // even though none of our runtime processes remain signalable. The group
      // was already sent SIGTERM above, so both outcomes mean replacement may
      // proceed without overlapping the old Electron instance.
      if (['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The group is exclusively the live runtime launched above. A stale member
  // must not survive into the replacement and keep the shared profile open.
  try {
    signalProcess(-pid, 'SIGKILL');
  } catch (error) {
    if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

export async function runLiveSupervisor(): Promise<number> {
  if (process.platform !== 'darwin' && process.env.EMDASH_LIVE_ALLOW_UNSUPPORTED !== '1') {
    throw new Error('Emdash 实时开发版目前只支持 macOS。');
  }

  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDirectory, '../../../..');
  const paths = defaultLivePaths();
  const source = inspectLiveSource(repoRoot);
  const previous = readLiveState(paths.statePath);
  const startedAt = Date.now();
  let state: LiveSupervisorState = {
    version: 1,
    ...source,
    ...(previous?.lastKnownGoodCommit && {
      lastKnownGoodCommit: previous.lastKnownGoodCommit,
    }),
    status: 'starting',
    supervisorPid: process.pid,
    startedAt,
    updatedAt: startedAt,
  };
  writeLiveState(paths.statePath, state);

  let stopping = false;
  let restarting = false;
  let child: ChildProcess;
  let settle: ((code: number) => void) | undefined;
  const exit = new Promise<number>((resolveExit) => {
    settle = resolveExit;
  });
  let changeTimer: NodeJS.Timeout | undefined;
  const write = (patch: Partial<LiveSupervisorState>) => {
    state = { ...state, ...patch, updatedAt: Date.now() };
    writeLiveState(paths.statePath, state);
  };
  const startChild = () => {
    const current = inspectLiveSource(repoRoot);
    state = { ...state, ...current, pendingCommit: undefined, error: undefined };
    const startedChild = startLiveChild(
      repoRoot,
      paths.statePath,
      paths.profilePath,
      paths.logPath,
      current
    );
    child = startedChild;
    write({ status: 'running', childPid: startedChild.pid });
    startedChild.once('error', (error) => {
      write({ status: 'failed', error: error.message, childPid: undefined });
      settle?.(1);
    });
    startedChild.once('exit', async (code, signal) => {
      if (restarting && !stopping) {
        try {
          await waitForLiveChildGroupExit(startedChild.pid);
          fulfillLiveBackupRequest(paths.profilePath, paths.statePath, state.runningCommit);
        } catch (error) {
          restarting = false;
          write({
            status: 'failed',
            error: `备份失败：${error instanceof Error ? error.message : String(error)}`,
            childPid: undefined,
          });
          settle?.(1);
          return;
        }
        restarting = false;
        startChild();
        return;
      }
      write({
        status: stopping || signal === 'SIGINT' || signal === 'SIGTERM' ? 'stopped' : 'failed',
        ...(code && { error: `electron-vite exited with code ${code}` }),
        childPid: undefined,
      });
      settle?.(code ?? (signal ? 0 : 1));
    });
  };
  startChild();

  const markRuntimeChange = () => {
    if (stopping || restarting) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const current = inspectLiveSource(repoRoot);
      write({
        ...current,
        pendingCommit: current.runningCommit,
        status: 'waiting_for_idle',
      });
    }, 250);
  };
  const runtimeWatchers = [
    join(repoRoot, 'apps', 'emdash-desktop', 'src', 'main'),
    join(repoRoot, 'apps', 'emdash-desktop', 'src', 'entry'),
    join(repoRoot, 'packages', 'core', 'src'),
    join(repoRoot, 'packages', 'shared', 'src'),
  ].map((path) => watch(path, { recursive: true }, markRuntimeChange));

  const restart = () => {
    if (stopping || restarting) return;
    restarting = true;
    write({ status: 'restarting' });
    signalLiveChildGroup(child, 'SIGTERM');
  };
  const markHealthy = () => {
    const current = inspectLiveSource(repoRoot);
    if (current.dirty || state.status !== 'running') return;
    write({
      ...current,
      lastKnownGoodCommit: current.runningCommit,
      lastHealthCheck: {
        commit: current.runningCommit,
        passed: true,
        checkedAt: Date.now(),
        failures: [],
      },
    });
  };
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    write({ status: 'stopping' });
    for (const watcher of runtimeWatchers) watcher.close();
    signalLiveChildGroup(child, signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGUSR2', restart);
  process.on('SIGUSR1', markHealthy);

  return await exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveSupervisor()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
