import type { BrowserWebviewAdapter } from '../../browser/browser-webview-types';

export type BrowserControls = {
  adapter: BrowserWebviewAdapter | null;
  focusUrl(): void;
  /**
   * Loads a URL as the address bar would. Works without an adapter too: the start page
   * has no webview (so no adapter) until a page loads, and this is what mounts one.
   */
  loadUrl(url: string): void;
};

class BrowserControlsRegistry {
  private readonly controls = new Map<string, BrowserControls>();

  register(browserId: string, controls: BrowserControls): () => void {
    this.controls.set(browserId, controls);
    return () => {
      if (this.controls.get(browserId) === controls) {
        this.controls.delete(browserId);
      }
    };
  }

  get(browserId: string): BrowserControls | undefined {
    return this.controls.get(browserId);
  }

  clear(): void {
    this.controls.clear();
  }
}

export const browserControlsRegistry = new BrowserControlsRegistry();
