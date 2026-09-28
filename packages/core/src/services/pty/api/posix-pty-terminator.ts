import { noopLogger, type Logger } from '@emdash/shared/logger';
import { waitForLocalProcessesToExit } from './process-exit';
import {
  collectLocalProcessInfosByPidAsync,
  collectLocalProcessTreeAsync,
  type ProcessInfo,
  type ProcessTreeSnapshot,
} from './process-tree';

const KILL_GRACE_MS = 2000;
/** How long past the SIGKILL escalation a kill waits for the tree to be gone. */
const EXIT_WAIT_MARGIN_MS = 1000;

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function pidsOf(processes: ProcessInfo[]): number[] {
  return processes.map(({ pid }) => pid);
}

function isKnownPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function isEscapedDescendant(root: ProcessInfo | undefined, descendant: ProcessInfo): boolean {
  if (!root) return true;

  if (isKnownPositiveInteger(root.sessionId) && isKnownPositiveInteger(descendant.sessionId)) {
    return descendant.sessionId !== root.sessionId;
  }

  if (isKnownPositiveInteger(root.pgid) && isKnownPositiveInteger(descendant.pgid)) {
    return descendant.pgid !== root.pgid;
  }

  return true;
}

function isSameProcessIdentity(expected: ProcessInfo, current: ProcessInfo | undefined): boolean {
  if (!current || current.pid !== expected.pid) return false;
  if (expected.startTime && current.startTime) return current.startTime === expected.startTime;
  return true;
}

export class PosixPtyTerminator {
  private rootKillTimer: ReturnType<typeof setTimeout> | null = null;
  private descendantKillTimer: ReturnType<typeof setTimeout> | null = null;
  private exited = false;

  constructor(private readonly logger: Logger = noopLogger) {}

  /**
   * Signals the tree, then resolves once its processes are gone (or the wait gives up
   * shortly after the SIGKILL escalation). Callers that start a replacement right away
   * (a resumed agent session) await it: an agent that is still shutting down may hold
   * locks on the very session the replacement opens.
   */
  async kill(rootPid: number, killPty: () => void): Promise<void> {
    const snapshot = await collectLocalProcessTreeAsync(rootPid, this.logger).catch(
      (): ProcessTreeSnapshot => ({ descendants: [] })
    );
    this.terminate(rootPid, snapshot, killPty);
    const escaped = snapshot.descendants.filter((descendant) =>
      isEscapedDescendant(snapshot.root, descendant)
    );
    await waitForLocalProcessesToExit(
      [-rootPid, ...pidsOf(escaped)],
      KILL_GRACE_MS + EXIT_WAIT_MARGIN_MS
    );
  }

  markExited(): void {
    this.exited = true;
    if (this.rootKillTimer) {
      clearTimeout(this.rootKillTimer);
      this.rootKillTimer = null;
    }
  }

  private terminate(rootPid: number, snapshot: ProcessTreeSnapshot, killPty: () => void): void {
    if (!this.exited) {
      try {
        process.kill(-rootPid, 'SIGTERM');
      } catch {}
      if (!this.exited) {
        this.rootKillTimer = setTimeout(() => {
          try {
            process.kill(-rootPid, 'SIGKILL');
          } catch {}
          this.rootKillTimer = null;
        }, KILL_GRACE_MS);
      }
    }

    const descendants = snapshot.descendants;
    if (descendants.length > 0) {
      signalPids(pidsOf(descendants), 'SIGTERM');
    }

    const escapedDescendants = descendants.filter((descendant) =>
      isEscapedDescendant(snapshot.root, descendant)
    );
    if (escapedDescendants.length > 0) {
      this.descendantKillTimer = setTimeout(() => {
        void this.signalMatchingProcessIdentities(escapedDescendants, 'SIGKILL').finally(() => {
          this.descendantKillTimer = null;
        });
      }, KILL_GRACE_MS);
    }

    if (!this.exited) {
      killPty();
    }
  }

  private async signalMatchingProcessIdentities(
    processes: ProcessInfo[],
    signal: NodeJS.Signals
  ): Promise<void> {
    const currentByPid = await collectLocalProcessInfosByPidAsync(pidsOf(processes), this.logger);
    const matchingPids = processes
      .filter((processInfo) =>
        isSameProcessIdentity(processInfo, currentByPid.get(processInfo.pid))
      )
      .map(({ pid }) => pid);
    signalPids(matchingPids, signal);
  }
}
