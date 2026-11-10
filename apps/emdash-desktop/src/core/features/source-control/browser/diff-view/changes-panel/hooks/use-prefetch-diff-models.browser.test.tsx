import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { commitRef } from '@core/primitives/git/api';
import { usePrefetchDiffModels } from './use-prefetch-diff-models';

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), releases: [] as Array<() => void> }));

vi.mock('@core/features/editor/api/browser/open-file-store/open-file-store', () => ({
  openFileStore: { acquire: mocks.acquire },
}));
vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useWorkspace: () => ({ workspaceId: 'workspace', path: '/repo' }),
}));

describe('diff prefetch', () => {
  it('uses both rename paths and releases the prior snapshot on ref changes', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.acquire.mockReset();
    mocks.releases = [];
    mocks.acquire.mockImplementation(() => {
      const release = vi.fn();
      mocks.releases.push(release);
      return { release };
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const originalRef = commitRef('a'.repeat(40));
    const modifiedRef = commitRef('b'.repeat(40));
    const nextRef = commitRef('c'.repeat(40));
    function Harness({ left }: { left: typeof originalRef }) {
      const prefetch = usePrefetchDiffModels('git', left, modifiedRef);
      return <button onClick={() => prefetch('new.txt', 'old.txt')}>Prefetch</button>;
    }
    try {
      await act(async () => root.render(<Harness left={originalRef} />));
      await act(async () => host.querySelector('button')!.click());
      expect(mocks.acquire).toHaveBeenCalledTimes(2);
      expect(mocks.acquire.mock.calls[0]![0].path.segments).toEqual(['repo', 'old.txt']);
      expect(mocks.acquire.mock.calls[1]![0].path.segments).toEqual(['repo', 'new.txt']);
      await act(async () => root.render(<Harness left={nextRef} />));
      expect(mocks.releases[0]).toHaveBeenCalledTimes(1);
      expect(mocks.releases[1]).toHaveBeenCalledTimes(1);
      await act(async () => host.querySelector('button')!.click());
      expect(mocks.acquire).toHaveBeenCalledTimes(4);
      expect(mocks.acquire.mock.calls[2]![1]).toEqual({ kind: 'git', ref: nextRef });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
