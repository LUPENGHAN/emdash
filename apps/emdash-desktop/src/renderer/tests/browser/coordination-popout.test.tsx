import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CoordinatorTaskPanel } from '@core/features/coordination/browser/coordinator-task-panel';
import { PopoutApp } from '@renderer/app/popout-app';

const state = vi.hoisted(() => ({
  task: { projectId: 'management-project', taskId: 'main-task' },
  popout: false,
  flush: vi.fn(),
}));

vi.mock('@core/features/tasks/contributions/browser/task-view-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTaskViewContext: () => state.task,
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTaskStore: () => ({ data: { type: 'coordination' }, displayName: '主任务' }),
}));
vi.mock('@core/features/workbench/api/browser/popout-mode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPopoutWindow: () => state.popout,
}));
vi.mock(
  '@core/features/workbench/api/browser/task-composition-context',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useTaskComposition: () => ({}),
  })
);
vi.mock('@core/features/coordination/api/browser/client', () => ({
  getCoordinationClient: async () => ({
    getByTask: async () => null,
    events: { subscribe: async () => () => {} },
  }),
}));
vi.mock('@core/primitives/desktop-host/browser/host-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHostClient: async () => ({
    getPopoutWindow: async () => ({ alwaysOnTop: false }),
    events: { subscribe: async () => () => {} },
  }),
}));
vi.mock('@core/primitives/mementos/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMementoClient: () => ({ flush: state.flush }),
}));
vi.mock('@core/primitives/navigation/browser/navigation-selectors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNavigation: () => ({ currentRef: { viewId: 'task', params: state.task } }),
}));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => ({ navigate: vi.fn() }),
  useWorkspaceViewParams: () => ({ params: state.task }),
  useWorkspaceSlots: () => ({
    WrapView: PassThrough,
    MainPanel: ConversationContent,
  }),
}));
vi.mock('@core/features/coordination/browser/coordinator-documents-panel', () => ({
  CoordinatorDocumentsPanel: () => null,
}));
vi.mock('@core/features/integrations/contributions/browser/integrations-provider', () => ({
  IntegrationsProvider: PassThrough,
}));
vi.mock('@core/features/localization/contributions/browser/ui-language', () => ({
  UiLanguage: () => null,
}));
vi.mock('@core/features/terminals/browser/pty/pty-pool-provider', () => ({
  TerminalPoolProvider: PassThrough,
}));
vi.mock('@core/features/workbench/browser/window-scope', () => ({ WindowScope: PassThrough }));
vi.mock('@core/features/workbench/contributions/browser/layout-provider', () => ({
  WorkspaceLayoutContextProvider: PassThrough,
}));
vi.mock('@core/primitives/theme/browser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTheme: () => {},
}));
vi.mock('@renderer/lib/keybindings', () => ({
  BrowserShortcutForwarding: () => null,
  KeybindingDispatcherMount: () => null,
}));
vi.mock('@renderer/lib/layout/provider', () => ({ WorkspaceViewProvider: PassThrough }));
vi.mock('@renderer/lib/modal/modal-renderer', () => ({ ModalRenderer: () => null }));
vi.mock('@renderer/lib/providers/theme-provider', () => ({ ThemeProvider: PassThrough }));

function PassThrough({ children }: { children: ReactNode }) {
  return children;
}

function ConversationContent() {
  return (
    <CoordinatorTaskPanel>
      <div data-testid="workspace-conversation">工作区对话</div>
    </CoordinatorTaskPanel>
  );
}

it.each(['main', 'popout'] as const)(
  'opens the conversation first in the %s window',
  async (window) => {
    state.popout = window === 'popout';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient();
    const renderWindow = () =>
      root.render(
        state.popout ? (
          <PopoutApp popoutId="popout-1" />
        ) : (
          <QueryClientProvider client={queryClient}>
            <span data-coordinator-view-switcher-slot />
            <ConversationContent />
          </QueryClientProvider>
        )
      );
    try {
      await act(async () => renderWindow());

      const switcher = page.getByRole('group', { name: '主任务工作区视图' });
      const overview = switcher.getByRole('button', { name: '概览' });
      const conversation = switcher.getByRole('button', { name: '对话' });
      const content = page.getByTestId('workspace-conversation');
      await expect.element(content).toBeVisible();
      await expect.element(conversation).toHaveAttribute('aria-pressed', 'true');

      await act(async () => overview.click());
      await expect.element(overview).toHaveAttribute('aria-pressed', 'true');
      await expect.element(content).not.toBeInTheDocument();

      await act(async () => conversation.click());
      await expect.element(content).toBeVisible();

      await act(async () => overview.click());
      await expect.element(overview).toHaveAttribute('aria-pressed', 'true');
      await act(async () => root.render(null));
      await act(async () => renderWindow());
      await expect.element(content).toBeVisible();
      await expect.element(conversation).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      host.remove();
    }
  }
);
