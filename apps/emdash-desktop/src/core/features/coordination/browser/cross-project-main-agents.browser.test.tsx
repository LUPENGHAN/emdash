import '@emdash/ui/style.css';
import '@renderer/index.css';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { Coordinator } from '../api/types';
import { CreateCrossProjectMainAgent, CrossProjectMainAgents } from './cross-project-main-agents';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  open: vi.fn(),
  completeAndArchive: vi.fn(),
  trash: vi.fn(),
  restoreTrash: vi.fn(),
  permanentlyDelete: vi.fn(),
  setLifecycleState: vi.fn(),
  update: vi.fn(),
  createCrossProject: vi.fn(),
  refetch: vi.fn(),
  navigate: vi.fn(),
}));

const state = vi.hoisted(() => ({
  records: [] as Coordinator[],
  projects: [] as Array<{ id: string; name: string; data?: { archivedAt?: number } }>,
}));

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
    permanentlyDelete: mocks.permanentlyDelete,
    setLifecycleState: mocks.setLifecycleState,
    update: mocks.update,
    createCrossProject: mocks.createCrossProject,
  }),
}));

vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({
    projects: new Map(state.projects.map((project) => [project.id, project])),
  }),
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
  useModalController: () => ({ complete: vi.fn(), dismiss: vi.fn() }),
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
    state.projects = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.querySelectorAll('[data-slot="context-menu-content"]').forEach((menu) => {
      menu.remove();
    });
    document.body.querySelectorAll('[data-slot="combobox-content"]').forEach((menu) => {
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
    expect(labels).toEqual(['打开', '重命名', '完成并归档', '仅归档', '删除…', '永久删除…']);
  });

  it('opens creation in a modal instead of embedding the form in the sidebar', async () => {
    await act(async () => root.render(<CrossProjectMainAgents />));
    expect(host.querySelector('[data-testid="cross-project-agent-form"]')).toBeNull();
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === '新建主任务工作区'
    );
    expect(create).toBeDefined();
    await act(async () => create!.click());
    expect(mocks.confirm).toHaveBeenCalledWith({});
  });

  it('scrolls a long main workspace list inside its bounded sidebar region', async () => {
    state.records = Array.from({ length: 24 }, (_, index) =>
      workspace({
        id: `cross:workspace-${index}`,
        taskId: `main-task-${index}`,
        name: `主任务工作区 ${index + 1}`,
      })
    );
    host.style.width = '280px';
    await act(async () =>
      root.render(
        <div className="flex flex-col" style={{ height: 320 }}>
          <CrossProjectMainAgents />
          <div className="min-h-0 flex-1" />
        </div>
      )
    );

    const scroller = host.querySelector<HTMLElement>('[data-testid="main-agent-workspace-scroll"]');
    expect(scroller).not.toBeNull();
    expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);
    scroller!.scrollTop = 120;
    scroller!.dispatchEvent(new Event('scroll'));
    expect(scroller!.scrollTop).toBeGreaterThan(0);
  });

  it('searches and selects linked repositories without rendering a checkbox list', async () => {
    state.projects = [
      { id: 'portal', name: 'portal-v4' },
      { id: 'sso', name: 'sso' },
      { id: 'deploy', name: 'deploy-test' },
    ];
    await act(async () => root.render(<CreateCrossProjectMainAgent />));

    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const search = page.getByPlaceholder('搜索仓库并选择…');
    await act(async () => userEvent.fill(search, 'portal'));
    await vi.waitFor(() => {
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options.map((option) => option.textContent?.trim())).toEqual(['portal-v4']);
    });
    const portal = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === 'portal-v4'
    );
    await act(async () => portal?.click());
    expect(host.textContent).toContain('portal-v4');
  });

  it('creates a workspace without pinning a main-task agent', async () => {
    mocks.createCrossProject.mockResolvedValue(workspace());
    await act(async () => root.render(<CreateCrossProjectMainAgent />));

    expect(host.textContent).not.toContain('主任务 Agent');
    expect(host.querySelector('[data-testid="cross-project-agent-type"]')).toBeNull();
    expect(host.textContent).toContain('创建工作区不会启动 Agent');

    await act(async () => userEvent.fill(page.getByPlaceholder('工作区名称'), '跨仓库发布'));
    const create = host.querySelector<HTMLButtonElement>(
      '[data-testid="create-cross-project-agent"]'
    );
    await act(async () => create?.click());

    await vi.waitFor(() => expect(mocks.createCrossProject).toHaveBeenCalledOnce());
    expect(mocks.createCrossProject).toHaveBeenCalledWith(
      expect.not.objectContaining({ primary: expect.anything() })
    );
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

  it('offers restore and permanent deletion in Trash', async () => {
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
      expect(labels).toEqual(['恢复', '永久删除…']);
    });
  });

  it('passes the explicit cascade choice to permanent deletion', async () => {
    mocks.confirm.mockResolvedValueOnce({
      success: true,
      data: { deleteChildren: true, deleteChildBranches: false },
    });
    await openMenu();
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === '永久删除…'
    );
    await act(async () => remove?.click());
    await vi.waitFor(() =>
      expect(mocks.permanentlyDelete).toHaveBeenCalledWith({
        id: 'cross:workspace',
        options: { deleteChildren: true, deleteChildBranches: false },
      })
    );
  });
});
