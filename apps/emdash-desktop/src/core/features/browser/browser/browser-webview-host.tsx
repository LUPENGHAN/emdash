import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { browserCaptureHolds } from '@core/features/browser/api/browser/browser-capture';
import { browserControlsRegistry } from '@core/features/browser/api/browser/browser-controls-registry';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { getBrowserClient } from '@core/features/browser/api/browser/client';
import { bindBrowserWebviewEvents } from './browser-webview-events';
import {
  createBrowserWebviewAdapter,
  type BrowserWebviewAdapter,
  type BrowserWebviewElement,
} from './browser-webview-types';

const WEBVIEW_ALLOW_POPUPS_ATTRIBUTE = 'true' as unknown as boolean;
const PARKED_WIDTH = 1280;
const PARKED_HEIGHT = 720;

/**
 * Live page adapter for a browser that may be parked off the task view. The pane reads
 * this; the webview element itself never lives in the pane.
 */
export const browserPageAdapters = observable.map<string, BrowserWebviewAdapter>();

export type BrowserWebviewSlot = {
  element: HTMLElement;
  visible: boolean;
  focusUrl(): void;
};

const slots = new Map<string, BrowserWebviewSlot>();
const lastSizes = new Map<string, { width: number; height: number }>();

/** The pane claims this while it is mounted. Releasing it parks the page; it does not close it. */
export function claimBrowserWebviewSlot(browserId: string, slot: BrowserWebviewSlot): () => void {
  slots.set(browserId, slot);
  return () => {
    if (slots.get(browserId) === slot) slots.delete(browserId);
  };
}

type PageMount = { partition: string; src: string; revision: number };

/**
 * One webview per open browser session, outside the task pane tree. Switching tasks
 * unmounts the pane; moving or remounting the webview would destroy the guest page.
 */
export const BrowserWebviewHost = observer(function BrowserWebviewHost() {
  const sessions = browserSessionStore.activeSessions;
  return (
    <>
      {sessions.map((session) => (
        <HostedBrowserPage key={session.browserId} browserId={session.browserId} />
      ))}
    </>
  );
});

const HostedBrowserPage = observer(function HostedBrowserPage({
  browserId,
}: {
  browserId: string;
}) {
  const session = browserSessionStore.getSession(browserId);
  const shellRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const [page, setPage] = useState<PageMount | null>(null);
  const [registered, setRegistered] = useState(false);
  const [webviewElement, setWebviewElement] = useState<BrowserWebviewElement | null>(null);
  const partition = session?.partition;
  const failed = Boolean(session && !session.isLoading && session.loadError);

  useEffect(() => {
    if (!session || !partition || session.currentUrl === 'about:blank') return;
    setPage((current) => {
      if (current?.partition === partition) return current;
      return { partition, src: session.currentUrl, revision: 0 };
    });
  }, [partition, session, session?.currentUrl]);

  useEffect(() => {
    if (!partition) return;
    let disposed = false;
    setRegistered(false);
    void getBrowserClient()
      .then((client) => client.registerSession({ browserId, partition }))
      .then((result) => {
        if (!disposed && result.success) setRegistered(true);
      });
    return () => {
      disposed = true;
    };
  }, [browserId, partition]);

  useEffect(() => {
    return browserControlsRegistry.register(browserId, {
      get adapter() {
        return browserPageAdapters.get(browserId) ?? null;
      },
      focusUrl: () => slots.get(browserId)?.focusUrl(),
      loadUrl: (url) => {
        const live = browserSessionStore.getSession(browserId);
        if (!live) return;
        browserSessionStore.updateSession(browserId, {
          currentUrl: url,
          faviconUrl: null,
          isLoading: true,
          loadError: null,
        });
        const adapter = browserPageAdapters.get(browserId);
        if (adapter) {
          void adapter.loadUrl(url);
          return;
        }
        setPage((current) => {
          if (current?.partition === live.partition && current.src === url) return current;
          if (current?.partition === live.partition) {
            return { partition: live.partition, src: url, revision: current.revision + 1 };
          }
          return { partition: live.partition, src: url, revision: 0 };
        });
      },
    });
  }, [browserId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0;
    const tick = () => {
      placeBrowserPage(shell, browserId);
      frame = requestFrame(tick);
    };
    tick();
    return () => cancelFrame(frame);
  }, [browserId]);

  const attachWebview = useCallback((node: Element | null) => {
    const next = node as BrowserWebviewElement | null;
    if (webviewRef.current === next) return;
    webviewRef.current = next;
    setWebviewElement(next);
  }, []);

  useEffect(() => {
    if (!webviewElement) {
      runInAction(() => browserPageAdapters.delete(browserId));
      return;
    }
    const dispose = bindBrowserWebviewEvents(browserId, webviewElement, {
      onDomReady: () => {
        if (webviewRef.current !== webviewElement) return;
        void getBrowserClient().then((client) =>
          client.bindWebContents({
            browserId,
            webContentsId: webviewElement.getWebContentsId(),
          })
        );
        runInAction(() => {
          browserPageAdapters.set(browserId, createBrowserWebviewAdapter(webviewElement));
        });
      },
    });
    return () => {
      dispose();
      runInAction(() => browserPageAdapters.delete(browserId));
    };
  }, [browserId, webviewElement]);

  const showWebview =
    Boolean(page) && registered && !failed && session?.currentUrl !== 'about:blank';

  return (
    <div ref={shellRef} data-browser-host-page={browserId} style={parkedStyle}>
      {showWebview && page ? (
        <webview
          key={`${page.partition}:${page.revision}`}
          ref={attachWebview}
          src={page.src}
          partition={page.partition}
          allowpopups={WEBVIEW_ALLOW_POPUPS_ATTRIBUTE}
          data-browser-id={browserId}
          className="h-full w-full bg-background"
        />
      ) : null}
    </div>
  );
});

const parkedStyle: CSSProperties = {
  position: 'fixed',
  left: -10000,
  top: 0,
  width: PARKED_WIDTH,
  height: PARKED_HEIGHT,
  visibility: 'hidden',
  opacity: 0,
  pointerEvents: 'none',
  zIndex: 30,
};

function placeBrowserPage(shell: HTMLElement, browserId: string): void {
  const slot = slots.get(browserId);
  const held = browserCaptureHolds.isHeld(browserId);
  if (slot) {
    const rect = slot.element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      lastSizes.set(browserId, { width: rect.width, height: rect.height });
    }
    const show = slot.visible || held;
    Object.assign(shell.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      visibility: show ? 'visible' : 'hidden',
      opacity: slot.visible ? '1' : '0',
      pointerEvents: slot.visible ? 'auto' : 'none',
    });
    return;
  }
  const size = lastSizes.get(browserId) ?? { width: PARKED_WIDTH, height: PARKED_HEIGHT };
  Object.assign(shell.style, {
    left: '-10000px',
    top: '0px',
    width: `${size.width}px`,
    height: `${size.height}px`,
    visibility: held ? 'visible' : 'hidden',
    opacity: '0',
    pointerEvents: 'none',
  });
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return window.setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
}
