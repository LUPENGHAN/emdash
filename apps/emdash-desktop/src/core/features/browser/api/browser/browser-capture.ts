import { action, makeObservable, observable } from 'mobx';
import type { BrowserWebviewAdapter } from '../../browser/browser-webview-types';
import { getBrowserClient } from './client';

/** Between tries: long enough for a frame once the page is drawn again. */
const FRAME_WAIT_MS = 150;
const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * Browsers being captured. A hidden tab's page is not drawn, so it has no frame to
 * capture; while held here, its tab is laid out and drawn but fully transparent.
 */
class BrowserCaptureHolds {
  readonly counts = observable.map<string, number>();

  constructor() {
    makeObservable(this, { hold: action, release: action });
  }

  isHeld(browserId: string): boolean {
    return (this.counts.get(browserId) ?? 0) > 0;
  }

  hold(browserId: string): void {
    this.counts.set(browserId, (this.counts.get(browserId) ?? 0) + 1);
  }

  release(browserId: string): void {
    const count = (this.counts.get(browserId) ?? 0) - 1;
    if (count > 0) this.counts.set(browserId, count);
    else this.counts.delete(browserId);
  }
}

export const browserCaptureHolds = new BrowserCaptureHolds();

/**
 * Captures the page for an agent whether or not anyone can see it: in a hidden tab, or
 * with Emdash behind other windows. Both stop the page from being drawn, which left
 * captures empty or waiting forever.
 */
export async function captureBrowserPage(
  browserId: string,
  adapter: BrowserWebviewAdapter
): Promise<{ dataUrl: string; width: number; height: number }> {
  const client = await getBrowserClient();
  browserCaptureHolds.hold(browserId);
  await client.holdPainting({ browserId, on: true }).catch(() => undefined);
  try {
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    for (;;) {
      await delay(FRAME_WAIT_MS);
      const remaining = deadline - Date.now();
      const shot = remaining > 0 ? await withTimeout(adapter.capturePng(), remaining) : null;
      if (shot && shot.width > 0 && shot.height > 0) return shot;
      if (Date.now() >= deadline) {
        throw new Error('The built-in browser did not draw the page; try the screenshot again');
      }
    }
  } finally {
    browserCaptureHolds.release(browserId);
    void client.holdPainting({ browserId, on: false }).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, delay(ms).then(() => null)]);
}
