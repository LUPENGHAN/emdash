import { describe, expect, it } from 'vitest';
import { agentProcessLabel, agentProcesses, agentRootProcesses } from './agent-process';

describe('agentProcessLabel', () => {
  it.each([
    ['/opt/homebrew/bin/codex --model gpt-6', 'Codex'],
    ['node "/Users/me/.local/lib/claude.js" --resume abc', 'Claude'],
    ['/usr/local/bin/opencode run', 'OpenCode'],
    ['gemini --yolo', 'Gemini'],
    ['cursor-agent --workspace /tmp/repo', 'Cursor Agent'],
  ])('identifies %s', (command, expected) => {
    expect(agentProcessLabel(command)).toBe(expected);
  });

  it('does not treat repository paths or Emdash helpers as agents', () => {
    expect(agentProcessLabel('node /Users/me/Claude-Detection/scripts/build.mjs')).toBeNull();
    expect(agentProcessLabel('emdash Helper (Renderer)')).toBeNull();
  });

  it('filters a process snapshot to agent-related rows', () => {
    const processes = [
      { pid: 1, ppid: 0, depth: 0, cpuPercent: 0, rssBytes: 10, command: 'emdash' },
      { pid: 2, ppid: 1, depth: 1, cpuPercent: 1, rssBytes: 20, command: 'codex --resume' },
    ];
    expect(agentProcesses(processes).map(({ pid }) => pid)).toEqual([2]);
  });

  it('counts one logical agent when it owns detected helper processes', () => {
    const processes = [
      { pid: 1, ppid: 0, depth: 0, cpuPercent: 0, rssBytes: 10, command: 'emdash' },
      { pid: 2, ppid: 1, depth: 1, cpuPercent: 1, rssBytes: 20, command: 'codex resume' },
      {
        pid: 3,
        ppid: 2,
        depth: 2,
        cpuPercent: 1,
        rssBytes: 20,
        command: 'codex-code-mode-host',
      },
      { pid: 4, ppid: 1, depth: 1, cpuPercent: 1, rssBytes: 20, command: 'claude --resume' },
    ];
    expect(agentProcesses(processes).map(({ pid }) => pid)).toEqual([2, 3, 4]);
    expect(agentRootProcesses(processes).map(({ pid }) => pid)).toEqual([2, 4]);
  });
});
