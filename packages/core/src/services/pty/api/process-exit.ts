const POLL_MS = 25;

/** Whether a local process (or, for a negative id, a process group) still exists. */
export function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Resolves once none of `pids` (negative: process groups) exists, or after `timeoutMs`. */
export async function waitForLocalProcessesToExit(
  pids: number[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isLocalProcessAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
