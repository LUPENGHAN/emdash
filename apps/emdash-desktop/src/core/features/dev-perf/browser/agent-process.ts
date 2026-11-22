import type { DevPerfProcess } from '../api/contract';

const AGENT_EXECUTABLES = [
  { label: 'Codex', pattern: /^codex(?:-[a-z0-9_-]+)?(?:\.(?:js|mjs|cjs))?$/i },
  { label: 'Claude', pattern: /^claude(?:-[a-z0-9_-]+)?(?:\.(?:js|mjs|cjs))?$/i },
  { label: 'OpenCode', pattern: /^opencode(?:-[a-z0-9_-]+)?(?:\.(?:js|mjs|cjs))?$/i },
  { label: 'Gemini', pattern: /^gemini(?:-[a-z0-9_-]+)?(?:\.(?:js|mjs|cjs))?$/i },
  { label: 'Cursor Agent', pattern: /^cursor-agent(?:-[a-z0-9_-]+)?$/i },
] as const;

/** Best-effort label from a full OS command line; paths and flags are never displayed as identity. */
export function agentProcessLabel(command: string): string | null {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    const basename = token.split(/[\\/]/).at(-1) ?? token;
    const match = AGENT_EXECUTABLES.find(({ pattern }) => pattern.test(basename));
    if (match) return match.label;
  }
  return null;
}

export function agentProcesses(processes: readonly DevPerfProcess[]): DevPerfProcess[] {
  return processes.filter(({ command }) => agentProcessLabel(command) !== null);
}

/**
 * Count logical agent launches rather than helper processes. A detected process whose
 * ancestor is also a detected agent process belongs to that ancestor's launch tree.
 */
export function agentRootProcesses(processes: readonly DevPerfProcess[]): DevPerfProcess[] {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const detectedPids = new Set(agentProcesses(processes).map(({ pid }) => pid));
  return agentProcesses(processes).filter((processInfo) => {
    const visited = new Set<number>();
    let parentPid = processInfo.ppid;
    while (parentPid > 0 && !visited.has(parentPid)) {
      if (detectedPids.has(parentPid)) return false;
      visited.add(parentPid);
      parentPid = byPid.get(parentPid)?.ppid ?? 0;
    }
    return true;
  });
}
