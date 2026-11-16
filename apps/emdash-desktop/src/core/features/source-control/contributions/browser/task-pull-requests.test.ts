import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskPullRequestRecord } from '../../api/task-pull-requests';
import { TaskPullRequestStatus } from './task-pull-requests';

const mocks = vi.hoisted(() => ({
  record: undefined as TaskPullRequestRecord | undefined,
  run: vi.fn(async () => {}),
  open: vi.fn(),
}));
vi.mock('@core/features/source-control/api/browser/client', () => ({
  getSourceControlClient: async () => ({
    taskPullRequests: {
      list: async () => (mocks.record ? [mocks.record] : []),
      run: mocks.run,
    },
  }),
}));
vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({ openExternal: mocks.open }));

let root: Root;
let dom: JSDOM;
let container: HTMLElement;
let queryClient: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.record = {
    version: '2',
    requestId: 'stable-request',
    fingerprint: 'fingerprint',
    phase: 'creating',
    error: 'Platform disconnected',
    plan: {
      taskId: 'worker',
      projectId: 'sdk',
      workspaceId: 'workspace',
      sourceRef: localBranchRefSchema.parse('refs/heads/feat/sdk'),
      oid: 'a'.repeat(40),
      pushTarget: {
        remote: 'personal',
        destination: 'https://github.com/me/sdk',
        fingerprint: 'b'.repeat(64),
      },
      repositoryUrl: 'https://github.com/org/sdk',
      headRepositoryUrl: 'https://github.com/me/sdk',
      base: 'develop',
      title: 'SDK change',
      draft: false,
    },
  };
  mocks.run.mockImplementation(async () => {
    if (!mocks.record) throw new Error('Missing request');
    mocks.record = {
      ...mocks.record,
      phase: 'complete',
      error: undefined,
      result: { url: 'https://github.com/org/sdk/pull/7', number: 7 },
    };
  });
  dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = dom.window.document.getElementById('root');
  if (!element) throw new Error('Missing root');
  container = element;
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
  dom.window.close();
});
async function render() {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TaskPullRequestStatus, { taskId: 'worker' })
      )
    );
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('SDK change');
  });
}

it('continues the frozen request and displays its resulting PR without resolving another target', async () => {
  await render();
  expect(container.textContent).toContain('https://github.com/me/sdk');
  expect(container.textContent).toContain('Target: https://github.com/org/sdk · develop');
  expect(container.textContent).toContain('Platform disconnected');
  const retry = container.querySelector<HTMLButtonElement>('[data-testid="retry-task-pr"]');
  if (!retry) throw new Error('Missing retry');
  await act(async () => {
    retry.click();
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain('PR complete');
  });
  expect(mocks.run).toHaveBeenCalledWith(
    { taskId: 'worker', requestId: 'stable-request' },
    { timeoutMs: 0 }
  );
  expect(container.querySelector('[data-testid="retry-task-pr"]')).toBeNull();
  expect(container.textContent).toContain('https://github.com/org/sdk/pull/7');
  expect(container.textContent).toContain('Target: https://github.com/org/sdk · develop');
});

it('keeps the saved target and retry entry visible after a continuation fails', async () => {
  mocks.run.mockRejectedValue(new Error('Host unavailable'));
  await render();
  const retry = container.querySelector<HTMLButtonElement>('[data-testid="retry-task-pr"]');
  if (!retry) throw new Error('Missing retry');
  await act(async () => {
    retry.click();
  });
  expect(container.textContent).toContain('Host unavailable');
  expect(container.textContent).toContain('Target: https://github.com/org/sdk · develop');
  expect(container.querySelector('[data-testid="retry-task-pr"]')).not.toBeNull();
});
