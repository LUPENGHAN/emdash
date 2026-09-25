import { hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { describe, expect, it, vi } from 'vitest';
import { listProjectImportableSessions } from './list-importable-sessions';

vi.mock('./external-sessions', () => ({ listExternalSessions: vi.fn() }));

/** First select: the owning row's workspace id; second: live conversation handles. */
function fakeDb(
  workspaceId: string | null,
  known: { id: string; providerSessionId: string | null }[]
) {
  const whereResults = [
    { limit: async () => (workspaceId ? [{ workspaceId }] : []) },
    Promise.resolve(known),
  ];
  let call = 0;
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => whereResults[call++] }) })),
  } as never;
}

describe('listProjectImportableSessions', () => {
  it('scans the project checkout and excludes sessions Emdash already tracks', async () => {
    const list = vi.fn(async () => []);
    const resolve = vi.fn(async () => ({ host: LOCAL_HOST_REF, path: '/work/repo' }));

    await listProjectImportableSessions(
      fakeDb('ws-repo', [
        { id: 'conv-1', providerSessionId: 'native-1' },
        { id: 'conv-2', providerSessionId: null },
      ]),
      { resolve },
      'project-1',
      list
    );

    expect(resolve).toHaveBeenCalledWith('ws-repo');
    expect(list).toHaveBeenCalledWith('/work/repo', {
      exclude: new Set(['conv-1', 'native-1', 'conv-2']),
    });
  });

  it('returns nothing for remote projects or projects without a checkout', async () => {
    const list = vi.fn(async () => []);
    const remote = { resolve: vi.fn(async () => ({ host: hostRef('remote', 'c'), path: '/r' })) };

    expect(await listProjectImportableSessions(fakeDb('ws', []), remote, 'p', list)).toEqual([]);
    expect(await listProjectImportableSessions(fakeDb(null, []), remote, 'p', list)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });
});
