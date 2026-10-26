import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { usePreviewServers } from '@core/features/workbench/api/browser/task-composition-context';
import {
  cycleNextTabCommand,
  cyclePreviousTabCommand,
} from '@core/features/workbench/contributions/commands';
import { normalizeBrowserUrl, normalizeBrowserZoomFactor } from '@core/primitives/browser/api';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import {
  browserLoadErrorCode,
  describeBrowserLoadError,
  type BrowserLoadErrorPresentation,
} from './browser-load-error';
import { decideBrowserReload } from './browser-navigation-controls';
import { BrowserStartPage } from './browser-start-page';
import { BrowserToolbar } from './browser-toolbar';
import { canOpenBrowserUrlExternally, openBrowserUrlExternally } from './browser-toolbar-actions';
import { browserPageAdapters, claimBrowserWebviewSlot } from './browser-webview-host';

export const BrowserPane = observer(function BrowserPane({
  browserId,
  visible,
}: {
  browserId: string;
  visible: boolean;
}) {
  const session = browserSessionStore.getSession(browserId);
  const { scopeInstance } = usePaneContext();
  const previewServers = usePreviewServers();
  const focusUrlRef = useRef<() => void>(() => {});
  const slotRef = useRef<HTMLDivElement>(null);
  const adapter = browserPageAdapters.get(browserId) ?? null;
  const sessionBrowserId = session?.browserId;
  const showStartPage = session?.currentUrl === 'about:blank' && !session.isLoading;
  const loadError = session && !session.isLoading ? session.loadError : undefined;
  const loadErrorUrl = loadError ? (loadError.url ?? session?.currentUrl ?? '') : '';
  const loadErrorPresentation = useMemo<BrowserLoadErrorPresentation | undefined>(
    () => (loadError ? describeBrowserLoadError(loadError, loadErrorUrl) : undefined),
    [loadError, loadErrorUrl]
  );
  const canOpenLoadErrorExternal = useMemo(
    () => (loadError ? canOpenBrowserUrlExternally(loadErrorUrl) : false),
    [loadError, loadErrorUrl]
  );

  const showPage = !showStartPage && !(loadError && loadErrorPresentation);

  useEffect(() => {
    if (!showPage) return;
    const node = slotRef.current;
    if (!node) return;
    return claimBrowserWebviewSlot(browserId, {
      element: node,
      visible,
      focusUrl: () => focusUrlRef.current(),
    });
  }, [browserId, showPage, visible]);

  useEffect(() => {
    return () => {
      void getBrowserClient().then((client) => client.setActiveBrowser({ browserId: null }));
    };
  }, []);

  useEffect(() => {
    if (!visible || !sessionBrowserId || adapter === null) return;
    void getBrowserClient().then((client) =>
      client.setActiveBrowser({ browserId: sessionBrowserId })
    );
  }, [adapter, sessionBrowserId, visible]);

  useEffect(() => {
    if (!visible || !sessionBrowserId) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getHostClient().then(async (client) => {
      const nextUnsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (
            event.type !== 'tab-navigation-shortcut' ||
            event.source.browserId !== sessionBrowserId
          ) {
            return;
          }
          const command =
            event.direction === 'next' ? cycleNextTabCommand : cyclePreviousTabCommand;
          void scopeInstance?.getCommand(command)?.execute(undefined, 'keybinding');
        },
        onGap: () => {},
      });
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [sessionBrowserId, scopeInstance, visible]);

  const loadUrl = useCallback(
    (url: string) => {
      browserControlsRegistry.get(browserId)?.loadUrl(url);
    },
    [browserId]
  );

  const navigateTo = useCallback(
    (url: string): boolean => {
      const normalized = normalizeBrowserUrl(url);
      if (!normalized.ok) return false;
      loadUrl(normalized.url);
      return true;
    },
    [loadUrl]
  );

  const goBack = useCallback(() => {
    if (!adapter?.canGoBack()) return;
    adapter.goBack();
  }, [adapter]);

  const goForward = useCallback(() => {
    if (!adapter?.canGoForward()) return;
    adapter.goForward();
  }, [adapter]);

  const reload = useCallback(() => {
    if (!session) return;
    const decision = decideBrowserReload({
      currentUrl: session.currentUrl,
      isLoading: session.isLoading,
      hasAdapter: adapter !== null,
    });
    if (decision.kind === 'reload-adapter') adapter?.reload();
    if (decision.kind === 'stop-adapter') adapter?.stop();
    if (decision.kind === 'retry-url') loadUrl(decision.url);
  }, [adapter, loadUrl, session]);

  const forceReload = useCallback(() => {
    if (adapter) {
      adapter.reloadIgnoringCache();
      return;
    }
    reload();
  }, [adapter, reload]);

  const setZoomFactor = useCallback(
    (factor: number) => {
      if (!sessionBrowserId) return;
      const zoomFactor = normalizeBrowserZoomFactor(factor);
      browserSessionStore.updateSession(sessionBrowserId, {
        zoomFactor,
      });
      adapter?.setZoomFactor(zoomFactor);
    },
    [adapter, sessionBrowserId]
  );

  if (!session) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-sm text-foreground-muted">
        Browser session unavailable
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <BrowserToolbar
        session={session}
        adapter={adapter}
        autoFocusUrl={showStartPage}
        onNavigate={navigateTo}
        onGoBack={goBack}
        onGoForward={goForward}
        onReload={reload}
        onForceReload={forceReload}
        onSetZoomFactor={setZoomFactor}
        onFocusUrl={(focus) => {
          focusUrlRef.current = focus;
        }}
      />
      <div className="emlight min-h-0 flex-1 bg-background">
        {loadError && loadErrorPresentation ? (
          <BrowserLoadErrorView
            url={loadErrorUrl}
            presentation={loadErrorPresentation}
            code={browserLoadErrorCode(loadError)}
            canOpenExternal={canOpenLoadErrorExternal}
            onReload={reload}
            onOpenExternal={() => openBrowserUrlExternally(loadErrorUrl)}
          />
        ) : showStartPage ? (
          <BrowserStartPage devServerUrls={previewServers.urls} onOpenUrl={navigateTo} />
        ) : (
          <div ref={slotRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
});

function BrowserLoadErrorView({
  presentation,
  code,
  url,
  canOpenExternal,
  onReload,
  onOpenExternal,
}: {
  presentation: BrowserLoadErrorPresentation;
  code: string | null;
  url: string;
  canOpenExternal: boolean;
  onReload: () => void;
  onOpenExternal: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-8">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 className="text-base font-medium text-foreground">{presentation.heading}</h1>
        <p className="text-sm text-foreground-muted" title={url}>
          {presentation.detail}
          {code && <span className="text-foreground-tertiary-muted"> ({code})</span>}
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onReload}>
            Reload
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canOpenExternal}
            onClick={onOpenExternal}
          >
            Open externally
          </Button>
        </div>
      </div>
    </div>
  );
}
