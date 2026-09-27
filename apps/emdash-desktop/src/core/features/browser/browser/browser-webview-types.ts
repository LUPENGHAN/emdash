export type BrowserWebviewEventMap = {
  'dom-ready': Event;
  'did-start-loading': Event;
  'did-stop-loading': Event;
  'did-navigate': { url: string };
  'did-navigate-in-page': { url: string };
  'did-fail-load': {
    errorCode: number;
    errorDescription: string;
    validatedURL: string;
    isMainFrame: boolean;
  };
  'console-message': { level: number; message: string; line: number; sourceId: string };
  'page-title-updated': { title: string };
  'page-favicon-updated': { favicons: string[] };
};

export type BrowserWebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  loadURL(url: string): Promise<void> | void;
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string; getSize(): { width: number; height: number } }>;
  sendInputEvent(event: BrowserInputEvent): void;
  insertText(text: string): Promise<void>;
  addEventListener<K extends keyof BrowserWebviewEventMap>(
    type: K,
    listener: (event: BrowserWebviewEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof BrowserWebviewEventMap>(
    type: K,
    listener: (event: BrowserWebviewEventMap[K]) => void
  ): void;
};

/** Electron input events for `<webview>.sendInputEvent`, in the page's CSS pixels. */
export type BrowserInputEvent =
  | {
      type: 'mouseDown' | 'mouseUp' | 'mouseMove';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
    }
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string };

export type BrowserWebviewAdapter = {
  canGoBack(): boolean;
  canGoForward(): boolean;
  currentUrl(): string;
  title(): string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  loadUrl(url: string): Promise<void>;
  setZoomFactor(factor: number): void;
  focus(): void;
  /** Automation (agent control): script, capture and input for the guest page. */
  executeJavaScript(code: string): Promise<unknown>;
  capturePng(): Promise<{ dataUrl: string; width: number; height: number }>;
  sendInputEvent(event: BrowserInputEvent): void;
  insertText(text: string): Promise<void>;
};

export function createBrowserWebviewAdapter(webview: BrowserWebviewElement): BrowserWebviewAdapter {
  return {
    canGoBack: () => webview.canGoBack(),
    canGoForward: () => webview.canGoForward(),
    currentUrl: () => webview.getURL(),
    title: () => webview.getTitle(),
    goBack: () => webview.goBack(),
    goForward: () => webview.goForward(),
    reload: () => webview.reload(),
    reloadIgnoringCache: () => webview.reloadIgnoringCache(),
    stop: () => webview.stop(),
    loadUrl: async (url: string) => {
      await webview.loadURL(url);
    },
    setZoomFactor: (factor: number) => webview.setZoomFactor(factor),
    focus: () => webview.focus(),
    executeJavaScript: (code: string) => webview.executeJavaScript(code, true),
    capturePng: async () => {
      const image = await webview.capturePage();
      return { dataUrl: image.toDataURL(), ...image.getSize() };
    },
    sendInputEvent: (event) => webview.sendInputEvent(event),
    insertText: (text: string) => webview.insertText(text),
  };
}
