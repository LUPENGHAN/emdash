import { ok } from '@emdash/shared';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProjectSelectors from '@core/features/projects/api/browser/stores/project-selectors';

const harness = vi.hoisted(() => ({
  wtSwitch: vi.fn(async () => ok(undefined)),
  repoSwitch: vi.fn(async () => ok(undefined)),
}));

vi.mock('@core/features/tasks/contributions/browser/task-view-context', () => ({
  useTaskViewContext: () => ({ projectId: 'project-1', taskId: 'task-1' }),
}));

vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: () => ({ workspaceId: 'wt-workspace' }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectSelectors>();
  return {
    ...actual,
    getProjectStore: () => ({
      name: 'repo',
      context: {
        kind: 'available',
        context: { project: { repositoryWorkspaceId: 'repo-workspace' } },
      },
    }),
  };
});

vi.mock('@core/features/source-control/api/browser/stores/source-control-selectors', () => ({
  getGitRepositoryStore: () => ({
    branchRefs: [
      { type: 'local', branch: 'main' },
      { type: 'local', branch: 'feature' },
    ],
    refsObservation: { kind: 'fresh' },
    loading: false,
    remotes: [{ name: 'origin', url: 'https://example.com/repo.git' }],
    baseRemote: { name: 'origin', url: 'https://example.com/repo.git' },
    refresh: vi.fn(),
  }),
  getGitCheckoutStore: (workspaceId: string) => {
    const checkout = {
      headKind: 'branch' as const,
      branchName: 'main',
      headDisplay: 'main',
      switchBranch: workspaceId === 'wt-workspace' ? harness.wtSwitch : harness.repoSwitch,
    };
    return workspaceId === 'wt-workspace' || workspaceId === 'repo-workspace'
      ? checkout
      : undefined;
  },
}));

vi.mock('@core/features/source-control/api/browser/use-git-actions', () => ({
  useGitActions: () => ({
    isPublished: false,
    aheadCount: 0,
    behindCount: 0,
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    publish: vi.fn(),
    isPublishing: false,
    isFetching: false,
    isPulling: false,
    isPushing: false,
  }),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => vi.fn(),
}));

vi.mock('@core/manifests/browser/project-availability-ui', () => ({
  projectAvailabilityUi: {
    getLiveActionDisabledReason: () => null,
  },
}));

describe('GitStatusSection branch switch', () => {
  let dom: JSDOM;
  let root: Root;

  beforeEach(async () => {
    harness.wtSwitch.mockClear();
    harness.repoSwitch.mockClear();
    harness.wtSwitch.mockResolvedValue(ok(undefined));
    harness.repoSwitch.mockResolvedValue(ok(undefined));

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('PointerEvent', dom.window.PointerEvent);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('NodeFilter', dom.window.NodeFilter);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => undefined,
    });
    if (!dom.window.HTMLElement.prototype.showPopover) {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'showPopover', {
        configurable: true,
        value: () => undefined,
      });
    }
    if (!dom.window.HTMLElement.prototype.hidePopover) {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'hidePopover', {
        configurable: true,
        value: () => undefined,
      });
    }
    vi.resetModules();
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('calls switchBranch on the task workspace only', async () => {
    const { GitStatusSection } = await import('./git-status-section');
    await act(async () => {
      root.render(<GitStatusSection />);
    });

    const trigger = [...dom.window.document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('main')
    );
    expect(trigger).toBeDefined();
    await act(async () => {
      trigger?.click();
    });

    const feature = [...dom.window.document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === 'feature'
    );
    expect(feature).toBeDefined();
    await act(async () => {
      feature?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.wtSwitch).toHaveBeenCalledTimes(1);
    expect(harness.wtSwitch).toHaveBeenCalledWith({ type: 'local', branch: 'feature' });
    expect(harness.repoSwitch).not.toHaveBeenCalled();
  });
});
