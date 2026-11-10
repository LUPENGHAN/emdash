import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveFile } from '@core/features/tasks/contributions/mementos';
import { commitRef } from '@core/primitives/git/api';
import { ImageDiffView } from './image-diff-view';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock('@core/features/source-control/api/browser/client', () => ({
  checkoutSelector: (workspaceId: string) => ({ workspaceId }),
  gitFilePath: (relativePath: string) => relativePath,
  getSourceControlClient: async () => ({ checkout: mocks }),
}));
vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'workspace',
    path: '/repo',
    sshConnectionId: undefined,
    get: () => ({ statusRevision: 0 }),
  }),
}));

/** One PNG-ish byte per side, so each query call is identifiable by its path. */
function blobFor(marker: number) {
  return {
    meta: { name: 'image.png', mimeType: 'image/png', size: 1 },
    bytes: async () => new Uint8Array([marker]),
  };
}

function render() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return { host, root };
}

const MERGE_BASE = commitRef('a'.repeat(40));
const HEAD = commitRef('b'.repeat(40));

function renamedFile(): ActiveFile {
  return {
    path: 'assets/new.png',
    originalPath: 'assets/old.png',
    type: 'git',
    group: 'git',
    originalRef: MERGE_BASE,
    modifiedRef: HEAD,
  } as ActiveFile;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ImageDiffView', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let client: QueryClient;

  beforeEach(() => {
    mocks.download.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    client.clear();
    host?.remove();
    root = null;
    host = null;
  });

  it('reads the two sides of a rename from their own paths and refs', async () => {
    mocks.download.mockImplementation(async (input: { path: string; source: unknown }) =>
      input.source !== null && typeof input.source === 'object' && 'kind' in input.source
        ? { success: true, data: blobFor(input.path === 'assets/old.png' ? 1 : 2) }
        : { success: false, error: { type: 'missing' } }
    );
    const rendered = render();
    root = rendered.root;
    host = rendered.host;

    await act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <ImageDiffView projectId="project" workspaceId="workspace" activeFile={renamedFile()} />
        </QueryClientProvider>
      )
    );

    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
    const calls = mocks.download.mock.calls.map(([input]) => input);
    const original = calls.find((call) => call.path === 'assets/old.png');
    const modified = calls.find((call) => call.path === 'assets/new.png');

    expect(original).toBeDefined();
    expect(modified).toBeDefined();
    // Left side reads the pre-rename path at the merge base, right side the new path at HEAD.
    expect(original!.source).toEqual({ kind: 'revision', revision: MERGE_BASE });
    expect(modified!.source).toEqual({ kind: 'revision', revision: HEAD });
  });

  it('falls back to the single path when a tab has no original path', async () => {
    mocks.download.mockResolvedValue({ success: true, data: blobFor(1) });
    const single = {
      path: 'assets/one.png',
      type: 'git',
      group: 'git',
      originalRef: MERGE_BASE,
      modifiedRef: HEAD,
    } as ActiveFile;
    const rendered = render();
    root = rendered.root;
    host = rendered.host;

    await act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <ImageDiffView projectId="project" workspaceId="workspace" activeFile={single} />
        </QueryClientProvider>
      )
    );

    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
    expect(mocks.download.mock.calls.map(([input]) => input.path)).toEqual([
      'assets/one.png',
      'assets/one.png',
    ]);
  });
});
