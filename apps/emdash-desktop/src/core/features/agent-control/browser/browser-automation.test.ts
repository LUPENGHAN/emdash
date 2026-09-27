// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runBrowserOp,
  type AutomatableBrowser,
  type BrowserInputEvent,
} from './browser-automation';

/** A browser whose "page" is this jsdom document. */
function fakeBrowser() {
  const events: BrowserInputEvent[] = [];
  const browser: AutomatableBrowser = {
    // Runs the page script against jsdom, like the webview would.
    executeJavaScript: async (code) => (0, eval)(code),
    capturePng: async () => ({ dataUrl: 'data:image/png;base64,QUJD', width: 800, height: 600 }),
    sendInputEvent: (event) => events.push(event),
    insertText: vi.fn(async () => {}),
    loadUrl: vi.fn(async () => {}),
    currentUrl: () => 'http://localhost:5173/',
    title: () => 'App',
    consoleEntries: () => [{ level: 'error', message: 'boom', url: 'app.js', line: 3 }],
  };
  return { browser, events };
}

beforeEach(() => {
  document.title = 'App';
  document.body.innerHTML = `
    <h1>Sign in</h1>
    <input name="email" placeholder="Email" />
    <button>Continue</button>
    <button style="display:none">Hidden</button>
    <a href="/help">Help</a>`;
  // jsdom has no layout: give every element a box so it counts as visible.
  Element.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50 } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => {};
});

describe('runBrowserOp', () => {
  it('snapshots headings and interactive elements with refs, skipping hidden ones', async () => {
    const { browser } = fakeBrowser();
    const { text } = await runBrowserOp(browser, { op: 'snapshot' });
    expect(text).toContain('# Sign in');
    expect(text).toMatch(/\[e1\] input "Email" type=text/);
    expect(text).toMatch(/\[e2\] button "Continue"/);
    expect(text).toMatch(/\[e3\] link "Help" href=\/help/);
    const elements = text.slice(text.indexOf('Elements:'), text.indexOf('Text:'));
    expect(elements).not.toContain('Hidden');
    expect(document.querySelector('button')?.getAttribute('data-emdash-ref')).toBe('e2');
  });

  it('clicks at the element center and types into it', async () => {
    const { browser, events } = fakeBrowser();
    await runBrowserOp(browser, { op: 'snapshot' });

    await runBrowserOp(browser, { op: 'click', ref: 'e2' });
    expect(events).toEqual([
      { type: 'mouseDown', x: 60, y: 35, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 60, y: 35, button: 'left', clickCount: 1 },
    ]);

    events.length = 0;
    await runBrowserOp(browser, { op: 'type', ref: 'e1', text: 'me@x.dev', submit: true });
    expect(document.activeElement?.getAttribute('name')).toBe('email');
    expect(browser.insertText).toHaveBeenCalledWith('me@x.dev');
    expect(events.map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp']);

    await expect(runBrowserOp(browser, { op: 'click', ref: 'e99' })).rejects.toThrow(
      'take a new browser_snapshot'
    );
  });

  it('reports console messages and returns screenshots as images', async () => {
    const { browser } = fakeBrowser();
    expect((await runBrowserOp(browser, { op: 'console' })).text).toBe('[error] boom (app.js:3)');
    const shot = await runBrowserOp(browser, { op: 'screenshot' });
    expect(shot.image).toEqual({ mimeType: 'image/png', data: 'QUJD' });
  });
});
