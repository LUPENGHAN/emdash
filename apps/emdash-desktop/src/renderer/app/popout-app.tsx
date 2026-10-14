import { Button, Toaster, Tooltip, toast } from '@emdash/ui/react/primitives';
import { QueryClientProvider } from '@tanstack/react-query';
import { PanelLeftClose, Pin, PinOff } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import { IntegrationsProvider } from '@core/features/integrations/contributions/browser/integrations-provider';
import { UiLanguage } from '@core/features/localization/contributions/browser/ui-language';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskPaneLayoutSnapshotSchema } from '@core/features/tasks/contributions/mementos';
import { TerminalPoolProvider } from '@core/features/terminals/browser/pty/pty-pool-provider';
import { confirmOpenExternalLink } from '@core/features/workbench/api/browser/open-external-link';
import {
  createPopoutLayoutMemento,
  setPopoutPaneLayout,
} from '@core/features/workbench/api/browser/popout-mode';
import { WindowScope } from '@core/features/workbench/browser/window-scope';
import { WorkspaceLayoutContextProvider } from '@core/features/workbench/contributions/browser/layout-provider';
import { COMMAND_CATALOG } from '@core/manifests/shared/command-catalog';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { ExternalLinkProvider } from '@core/primitives/external-links/browser';
import { useMementoClient } from '@core/primitives/mementos/react';
import {
  useWorkspaceSlots,
  useWorkspaceViewParams,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { queryClient } from '@core/primitives/query/browser/query-client';
import { useTheme } from '@core/primitives/theme/browser';
import { scopes } from '@core/primitives/view-scopes/browser';
import { BrowserShortcutForwarding, KeybindingDispatcherMount } from '@renderer/lib/keybindings';
import { WorkspaceViewProvider } from '../lib/layout/provider';
import { ModalRenderer } from '../lib/modal/modal-renderer';
import { FeatureFlagProvider } from '../lib/providers/feature-flag-override-context';
import { ThemeProvider } from '../lib/providers/theme-provider';

type PreparedPopout = { id: string; projectId: string; taskId: string };

/**
 * Loads this window's record and hands its layout to the task view before any store is
 * built. A window whose record is gone (its tabs went back) just closes.
 */
export async function preparePopout(id: string): Promise<PreparedPopout> {
  const client = await getHostClient();
  const record = await client.getPopoutWindow({ id });
  if (!record) {
    window.close();
    return new Promise(() => {});
  }
  const parsed = taskPaneLayoutSnapshotSchema.safeParse(record.layout);
  setPopoutPaneLayout(
    record.taskId,
    createPopoutLayoutMemento(
      parsed.success ? { version: '2', ...parsed.data } : null,
      (layout) => {
        void client.updatePopoutWindow({ id, layout });
      }
    )
  );
  document.title = record.title;
  return { id, projectId: record.projectId, taskId: record.taskId };
}

/** A window showing some of one task's tabs, outside the main window. */
export function PopoutApp({ popoutId }: { popoutId: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FeatureFlagProvider>
        <Tooltip.Provider delay={300}>
          <WorkspaceLayoutContextProvider>
            <TerminalPoolProvider>
              <IntegrationsProvider>
                <WorkspaceViewProvider>
                  <ExternalLinkProvider openExternalLink={confirmOpenExternalLink}>
                    <ThemeProvider>
                      <ModalRenderer />
                      <PopoutLifecycle popoutId={popoutId} />
                      <UiLanguage />
                      <PopoutWorkspace popoutId={popoutId} />
                    </ThemeProvider>
                  </ExternalLinkProvider>
                </WorkspaceViewProvider>
              </IntegrationsProvider>
            </TerminalPoolProvider>
          </WorkspaceLayoutContextProvider>
        </Tooltip.Provider>
      </FeatureFlagProvider>
    </QueryClientProvider>
  );
}

const PopoutWorkspace = observer(function PopoutWorkspace({ popoutId }: { popoutId: string }) {
  useTheme();
  const { WrapView, MainPanel } = useWorkspaceSlots();
  const { params } = useWorkspaceViewParams();
  const onTask = getNavigation().currentRef.viewId === 'task';
  return (
    <WindowScope>
      <BrowserShortcutForwarding />
      <KeybindingDispatcherMount />
      <div className="flex h-screen flex-col bg-background text-foreground">
        <PopoutTitlebar popoutId={popoutId} />
        <div className="min-h-0 flex-1">
          {onTask ? (
            <WrapView {...params}>
              <MainPanel />
            </WrapView>
          ) : null}
        </div>
      </div>
      <Toaster />
    </WindowScope>
  );
});

const PopoutTitlebar = observer(function PopoutTitlebar({ popoutId }: { popoutId: string }) {
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const ref = getNavigation().currentRef;
  const { projectId, taskId } = ref.params as { projectId?: string; taskId?: string };
  const title = (projectId && taskId && getTaskStore(projectId, taskId)?.displayName) || '';

  useEffect(() => {
    void getHostClient()
      .then((client) => client.getPopoutWindow({ id: popoutId }))
      .then((record) => setAlwaysOnTop(record?.alwaysOnTop ?? false));
  }, [popoutId]);

  const toggleOnTop = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    await (await getHostClient()).setPopoutAlwaysOnTop({ id: popoutId, alwaysOnTop: next });
  };
  const moveBack = async () => {
    await (await getHostClient()).returnPopoutWindow({ id: popoutId });
  };

  return (
    <div
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 [-webkit-app-region:drag] ${
        // Leaves room for the macOS window buttons.
        navigator.userAgent.includes('Mac') ? 'pl-20' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate pl-3 text-sm text-foreground-muted">{title}</span>
      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={alwaysOnTop}
          title={alwaysOnTop ? 'Stop keeping on top' : 'Keep on top'}
          onClick={() => void toggleOnTop()}
        >
          {alwaysOnTop ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {alwaysOnTop ? 'On top' : 'Keep on top'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void moveBack()}>
          <PanelLeftClose className="size-4" />
          Move to Main Window
        </Button>
      </div>
    </div>
  );
});

/**
 * Menu shortcuts aimed at this window run here. Quitting is confirmed by the main
 * window; this one only holds the quit back while it has unsaved files, which the main
 * window cannot see.
 */
function PopoutLifecycle({ popoutId }: { popoutId: string }) {
  const mementoClient = useMementoClient();
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getHostClient().then(async (client) => {
      const next = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (event.type === 'menu-command' && event.popoutId === popoutId) {
            const command = COMMAND_CATALOG.byId(event.commandId);
            const bound = command ? scopes.getActiveCommand(command) : undefined;
            if (bound?.availability.kind === 'enabled') bound.execute(undefined, 'menu');
          } else if (event.type === 'quit-confirmation-requested') {
            if (openFileStore.dirtyEntries().length === 0) return;
            void client.resolveQuitConfirmation({ requestId: event.requestId, confirmed: false });
            window.focus();
            toast.error('This window has unsaved files', {
              description: 'Save or discard them, then quit again.',
            });
          } else if (event.type === 'shutdown-started') {
            void mementoClient.flush().catch(() => {});
          }
        },
        onGap: () => {},
      });
      if (disposed) next();
      else unsubscribe = next;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [mementoClient, popoutId]);
  return null;
}
