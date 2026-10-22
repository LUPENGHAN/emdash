import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWebviewAdapter } from '../../browser/browser-webview-types';
import { browserCaptureHolds, captureBrowserPage } from './browser-capture';

const client = vi.hoisted(() => ({ holdPainting: vi.fn(async () => ({ success: true })) }));

vi.mock('./client', () => ({ getBrowserClient: async () => client }));

const empty = { dataUrl: 'data:,', width: 0, height: 0 };
const page = { dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 600 };

function adapterCapturing(...shots: Array<Promise<typeof page>>): BrowserWebviewAdapter {
  const capturePng = vi.fn();
  for (const shot of shots) capturePng.mockReturnValueOnce(shot);
  return { capturePng } as unknown as BrowserWebviewAdapter;
}

describe('captureBrowserPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    client.holdPainting.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws the page while capturing and tries again until a frame arrives', async () => {
    const adapter = adapterCapturing(Promise.resolve(empty), Promise.resolve(page));
    const capturing = captureBrowserPage('b1', adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(browserCaptureHolds.isHeld('b1')).toBe(true);
    await vi.advanceTimersByTimeAsync(400);

    await expect(capturing).resolves.toEqual(page);
    expect(adapter.capturePng).toHaveBeenCalledTimes(2);
    expect(browserCaptureHolds.isHeld('b1')).toBe(false);
    expect(client.holdPainting.mock.calls).toEqual([
      [{ browserId: 'b1', on: true }],
      [{ browserId: 'b1', on: false }],
    ]);
  });

  it('gives up with an error instead of waiting forever for a frame', async () => {
    const adapter = adapterCapturing(new Promise<typeof page>(() => {}));
    const capturing = captureBrowserPage('b2', adapter);
    const settled = expect(capturing).rejects.toThrow('did not draw the page');
    await vi.advanceTimersByTimeAsync(11_000);
    await settled;
    expect(browserCaptureHolds.isHeld('b2')).toBe(false);
    expect(client.holdPainting).toHaveBeenLastCalledWith({ browserId: 'b2', on: false });
  });
});
