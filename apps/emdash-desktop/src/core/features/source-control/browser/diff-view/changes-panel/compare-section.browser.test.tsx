import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangesViewStore } from '../stores/changes-view-store';
import { CompareSectionBody, useCompareSection } from './compare-section';

const mocks = vi.hoisted(() => ({
  getMergeBase: vi.fn(),
  getChangedFiles: vi.fn(),
  getLog: vi.fn(),
  getCommit: vi.fn(),
  open: vi.fn(),
  repo: {
    resyncRequired: vi.fn(async () => {}),
    refsObservation: { kind: 'fresh' },
    defaultBranchRef: { type: 'local', branch: 'main' },
    branches: [
      { type: 'local', ref: 'refs/heads/main', oid: 'a'.repeat(40) },
      { type: 'local', ref: 'refs/heads/other', oid: 'b'.repeat(40) },
    ],
  },
  checkout: { resyncRequired: vi.fn(async () => {}), headOid: 'c'.repeat(40) },
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectStore: () => ({}),
  asAvailableProject: () => ({ host: { state: { kind: 'ready', hostGeneration: 1 } } }),
}));
vi.mock('@core/features/source-control/api/browser/stores/source-control-selectors', () => ({
  getGitRepositoryStore: () => mocks.repo,
}));
vi.mock('@core/features/source-control/api/browser/client', () => ({
  checkoutSelector: (workspaceId: string) => ({ workspaceId }),
  getSourceControlClient: async () => ({ checkout: mocks }),
}));
vi.mock('@core/features/tasks/contributions/browser/task-view-context', () => ({
  useTaskViewContext: () => ({ projectId: 'project' }),
}));
vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useWorkspace: () => ({ workspaceId: 'workspace', path: '/repo', get: () => mocks.checkout }),
  useTaskComposition: () => ({ activePane: { open: mocks.open } }),
}));
vi.mock('@core/features/source-control/contributions/browser/project-branch-selector', () => ({
  ProjectBranchSelector: () => null,
}));
vi.mock('./hooks/use-prefetch-diff-models', () => ({ usePrefetchDiffModels: () => () => {} }));
vi.mock('../pane-selectors', () => ({ activeDiffEntry: () => undefined }));
vi.mock('./components/changes-list-or-tree', () => ({
  ChangesListOrTree: ({
    changes,
    onSelectChange,
  }: {
    changes: Array<{ path: string }>;
    onSelectChange: (change: { path: string }) => void;
  }) => (
    <div>
      {changes.map((change) => (
        <button key={change.path} onClick={() => onSelectChange(change)}>
          {change.path}
        </button>
      ))}
    </div>
  ),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Compare section', () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: ChangesViewStore;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMergeBase.mockReset();
    mocks.getChangedFiles.mockReset();
    mocks.getLog.mockReset();
    mocks.getCommit.mockReset();
    mocks.repo.resyncRequired.mockReset().mockResolvedValue(undefined);
    mocks.checkout.resyncRequired.mockReset().mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    store = new ChangesViewStore(
      { isLoading: true, unstagedFileChanges: [], stagedFileChanges: [] } as never,
      { pullRequests: [] } as never,
      {
        value: undefined,
        set: vi.fn(),
      }
    );
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    store.dispose();
    client.clear();
    host.remove();
  });

  it('ignores an earlier branch request and opens the selected immutable snapshot', async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.getMergeBase.mockImplementation(({ baseOid }: { baseOid: string }) =>
      baseOid.startsWith('a')
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({ success: true, data: { oid: 'd'.repeat(40) } })
    );
    mocks.getChangedFiles.mockResolvedValue({
      success: true,
      data: {
        files: [
          {
            path: 'new.txt',
            originalPath: 'old.txt',
            status: 'renamed',
            additions: 1,
            deletions: 1,
          },
        ],
      },
    });
    function Harness() {
      const compare = useCompareSection(store);
      return (
        <>
          <button onClick={() => compare.setSelectedBranch({ type: 'local', branch: 'other' })}>
            Other
          </button>
          <CompareSectionBody compare={compare} />
        </>
      );
    }
    const ObservedHarness = observer(Harness);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ObservedHarness />
        </QueryClientProvider>
      )
    );
    await vi.waitFor(() => expect(mocks.getMergeBase).toHaveBeenCalledTimes(1));
    await act(async () => host.querySelector('button')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain('new.txt'));
    await act(async () => resolveFirst({ success: true, data: { oid: 'e'.repeat(40) } }));
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'new.txt')!
        .click()
    );
    expect(mocks.open).toHaveBeenCalledWith(
      'diff',
      expect.objectContaining({
        activeFile: expect.objectContaining({
          path: 'new.txt',
          originalPath: 'old.txt',
          originalRef: { kind: 'commit', sha: 'd'.repeat(40) },
          modifiedRef: { kind: 'commit', sha: 'c'.repeat(40) },
        }),
      }),
      { preview: true }
    );
    expect(mocks.getChangedFiles).toHaveBeenCalledTimes(1);
  });

  it('waits for both Git snapshots before comparing', async () => {
    let finishRefresh!: () => void;
    mocks.repo.resyncRequired.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    mocks.getMergeBase.mockResolvedValue({ success: true, data: { oid: 'd'.repeat(40) } });
    mocks.getChangedFiles.mockResolvedValue({ success: true, data: { files: [] } });
    function Harness() {
      const compare = useCompareSection(store);
      return <CompareSectionBody compare={compare} />;
    }
    const ObservedHarness = observer(Harness);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ObservedHarness />
        </QueryClientProvider>
      )
    );
    expect(mocks.getMergeBase).not.toHaveBeenCalled();
    await act(async () => finishRefresh());
    await vi.waitFor(() => expect(host.textContent).toContain('No committed changes to compare.'));
    expect(mocks.getMergeBase).toHaveBeenCalledTimes(1);
  });

  it('rejects revision expressions and commits returned for a different object', async () => {
    store.setCompareMode('commit');
    store.setCompareSubmittedCommit('HEAD~1');
    mocks.getLog.mockResolvedValue({ success: true, data: { commits: [], totalCount: 0 } });
    mocks.getCommit.mockResolvedValue({
      success: true,
      data: { commit: { hash: 'd'.repeat(40) } },
    });
    function Harness() {
      const compare = useCompareSection(store);
      return <CompareSectionBody compare={compare} />;
    }
    const ObservedHarness = observer(Harness);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ObservedHarness />
        </QueryClientProvider>
      )
    );
    await vi.waitFor(() => expect(host.textContent).toContain('Enter a hexadecimal commit ID.'));
    expect(mocks.getCommit).not.toHaveBeenCalled();
    await act(async () => store.setCompareSubmittedCommit('aaaa'));
    await vi.waitFor(() => expect(host.textContent).toContain('Commit not found or ambiguous.'));
    expect(mocks.getCommit).toHaveBeenCalledTimes(1);
    expect(mocks.getMergeBase).not.toHaveBeenCalled();
  });

  it('resolves a short commit ID to a fixed comparison snapshot', async () => {
    store.setCompareMode('commit');
    store.setCompareSubmittedCommit('abcd');
    const commitOid = `abcd${'1'.repeat(36)}`;
    mocks.getLog.mockResolvedValue({ success: true, data: { commits: [], totalCount: 0 } });
    mocks.getCommit.mockResolvedValue({ success: true, data: { commit: { hash: commitOid } } });
    mocks.getMergeBase.mockResolvedValue({ success: true, data: { oid: 'd'.repeat(40) } });
    mocks.getChangedFiles.mockResolvedValue({ success: true, data: { files: [] } });
    function Harness() {
      const compare = useCompareSection(store);
      return <CompareSectionBody compare={compare} />;
    }
    const ObservedHarness = observer(Harness);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ObservedHarness />
        </QueryClientProvider>
      )
    );
    await vi.waitFor(() => expect(host.textContent).toContain('No committed changes to compare.'));
    expect(mocks.getMergeBase).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      baseOid: commitOid,
      headOid: 'c'.repeat(40),
    });
    expect(mocks.getChangedFiles).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      target: {
        kind: 'merge-base',
        base: { kind: 'commit', sha: commitOid },
        head: { kind: 'commit', sha: 'c'.repeat(40) },
      },
    });
  });
});
