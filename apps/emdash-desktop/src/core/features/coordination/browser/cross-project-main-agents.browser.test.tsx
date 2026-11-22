import '@emdash/ui/style.css';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coordinator } from '../api/types';
import { CrossProjectMainAgents } from './cross-project-main-agents';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  open: vi.fn(),
  completeAndArchive: vi.fn(),
  trash: vi.fn(),
  restoreTrash: vi.fn(),
  setLifecycleState: vi.fn(),
  update: vi.fn(),
  refetch: vi.fn(),
  navigate: vi.fn(),
}));

const state = vi.hoisted(() => ({ records: [] as Coordinator[] }));

vi.mock('../api/browser/use-coordinators', () => ({
  useCoordinators: () => ({
    data: state.records,
    isPending: false,
    isError: false,
    refetch: mocks.refetch,
  }),
}));

vi.mock('../api/browser/client', () => ({
  getCoordinationClient: async () => ({
    open: mocks.open,
    completeAndArchive: mocks.completeAndArchive,
    trash: mocks.trash,
    restoreTrash: mocks.restoreTrash,
    setLifecycleState: mocks.setLifecycleState,
    update: mocks.update,
  }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));

vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: () => undefined,
}));

vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
  useViewParams: () => undefined,
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.confirm,
}));

function workspace(overrides: Partial<Coordinator> = {}): Coordinator {
  return {
    version: '12',
    id: 'cross:workspace',
    kind: 'cross-project',
    name: '缓存命中率排查',
    projectId: 'management',
    projectIds: [],
    taskId: 'main-task',
    conversationId: 'main-conversation',
    primary: { agent: 'codex' },
    delegationDefaults: {},
    tasks: {},
    events: [],
    purpose: '找出缓存命中率为零的原因',
    lifecycle: { kind: 'finite', state: 'active' },
    workItems: {},
    checkpoints: [],
    optimizationRuns: {},
    optimizationSuggestions: {},
    livePromotions: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Main Agent workspace context menu', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.confirm.mockResolvedValue({ success: true, data: undefined });
    mocks.refetch.mockResolvedValue(undefined);
    mocks.trash.mockResolvedValue(workspace({ deletedAt: Date.now() }));
    state.records = [workspace()];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.querySelectorAll('[data-slot="context-menu-content"]').forEach((menu) => {
      menu.remove();
    });
    host.remove();
  });

  async function openMenu() {
    await act(async () => root.render(<CrossProjectMainAgents />));
    const row = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('缓存命中率排查')
    );
    expect(row).toBeDefined();
    await act(async () => {
      row!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 2 })
      );
      row!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      );
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="context-menu-content"]')).not.toBeNull();
    });
  }

  it('shows only the agreed Chinese workspace actions', async () => {
    await openMenu();
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
      item.textContent?.trim()
    );
    expect(labels).toEqual(['打开', '重命名', '完成并归档', '仅归档', '删除…']);
  });

  it('blocks completion and deletion while an execution task is active', async () => {
    state.records = [
      workspace({
        tasks: {
          worker: {
            taskId: 'worker',
            projectId: 'project',
            name: '实现',
            state: 'assigned',
            resultVersion: 0,
            submissions: {},
          },
        },
      }),
    ];
    await openMenu();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const complete = items.find((item) => item.textContent?.includes('完成并归档'));
    const remove = items.find((item) => item.textContent?.includes('删除'));
    expect(complete?.getAttribute('aria-disabled')).toBe('true');
    expect(remove?.getAttribute('aria-disabled')).toBe('true');
    expect(complete?.getAttribute('title')).toContain('1 个执行任务');
    expect(remove?.getAttribute('title')).toContain('1 个执行任务');
  });

  it('confirms recoverable deletion before moving a workspace to Trash', async () => {
    await openMenu();
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('删除')
    );
    await act(async () => remove?.click());
    await vi.waitFor(() => expect(mocks.trash).toHaveBeenCalledWith({ id: 'cross:workspace' }));
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: '移到废纸篓？',
      description: expect.stringContaining('关联项目、任务、决策和记忆不会被删除'),
      confirmLabel: '移到废纸篓',
    });
  });

  it('offers restore as the only action in Trash', async () => {
    state.records = [workspace({ deletedAt: Date.now() })];
    await act(async () => root.render(<CrossProjectMainAgents />));
    const filter = host.querySelector<HTMLElement>('[data-testid="main-workspace-filter"]');
    await act(async () => filter?.click());
    const trashOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === '废纸篓'
    );
    expect(trashOption).toBeDefined();
    await act(async () => trashOption!.click());
    const row = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('缓存命中率排查')
    );
    expect(row).toBeDefined();
    await act(async () => {
      row!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 2 })
      );
      row!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      );
    });
    await vi.waitFor(() => {
      const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
        item.textContent?.trim()
      );
      expect(labels).toEqual(['恢复']);
    });
  });
});
