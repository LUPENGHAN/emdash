import { hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { describe, expect, it, vi } from 'vitest';
import type { ImportableSession } from '@core/primitives/conversations/api';
import { listProjectImportableSessions } from './list-importable-sessions';

vi.mock('./external-sessions', () => ({ listExternalSessions: vi.fn() }));

type Worktree = { id: string; path: string | null; location: 'local' | 'remote' | null };

/** Selects in order: the project's checkout id, its live worktrees, task-bound handles. */
function fakeDb(
  repositoryId: string | null,
  worktrees: Worktree[],
  known: { id: string; providerSessionId: string | null }[]
) {
  const whereResults = [
    { limit: async () => (repositoryId ? [{ workspaceId: repositoryId }] : []) },
    Promise.resolve(worktrees),
    Promise.resolve(known),
  ];
  let call = 0;
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => whereResults[call++] }) })),
  } as never;
}

function session(sessionId: string, cwd: string): ImportableSession {
  return {
    providerId: 'claude',
    sessionId,
    title: sessionId,
    firstMessage: null,
    updatedAt: 1,
    cwd,
  };
}

describe('listProjectImportableSessions', () => {
  it('scans the checkout and its local worktrees, tagging each session with its workspace', async () => {
    const list = vi.fn(async () => [
      session('s-main', '/work/repo'),
      session('s-wt', '/work/repo/.claude/worktrees/x'),
    ]);
    const resolve = vi.fn(async () => ({ host: LOCAL_HOST_REF, path: '/work/repo' }));

    const sessions = await listProjectImportableSessions(
      fakeDb(
        'ws-repo',
        [
          { id: 'ws-wt', path: '/work/repo/.claude/worktrees/x', location: 'local' },
          { id: 'ws-remote', path: '/srv/repo-wt', location: 'remote' },
          { id: 'ws-pathless', path: null, location: 'local' },
        ],
        [
          { id: 'conv-1', providerSessionId: 'native-1' },
          { id: 'conv-2', providerSessionId: null },
        ]
      ),
      { resolve },
      'project-1',
      list
    );

    expect(resolve).toHaveBeenCalledWith('ws-repo');
    expect(list).toHaveBeenCalledWith(['/work/repo', '/work/repo/.claude/worktrees/x'], {
      exclude: new Set(['conv-1', 'native-1', 'conv-2']),
    });
    expect(sessions.map((s) => [s.sessionId, s.workspaceId])).toEqual([
      ['s-main', 'ws-repo'],
      ['s-wt', 'ws-wt'],
    ]);
  });

  it('returns nothing for remote projects or projects without a checkout', async () => {
    const list = vi.fn(async () => []);
    const remote = { resolve: vi.fn(async () => ({ host: hostRef('remote', 'c'), path: '/r' })) };

    expect(await listProjectImportableSessions(fakeDb('ws', [], []), remote, 'p', list)).toEqual(
      []
    );
    expect(await listProjectImportableSessions(fakeDb(null, [], []), remote, 'p', list)).toEqual(
      []
    );
    expect(list).not.toHaveBeenCalled();
  });
});
