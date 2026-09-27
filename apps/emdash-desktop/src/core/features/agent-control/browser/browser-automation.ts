import type { AgentControlResult, BrowserOp } from '../api';

/** Electron `<webview>.sendInputEvent` input, in the page's CSS pixels. */
export type BrowserInputEvent =
  | {
      type: 'mouseDown' | 'mouseUp' | 'mouseMove';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
    }
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string };

/** What the automation needs from a built-in browser tab. */
export type AutomatableBrowser = {
  executeJavaScript(code: string): Promise<unknown>;
  capturePng(): Promise<{ dataUrl: string; width: number; height: number }>;
  sendInputEvent(event: BrowserInputEvent): void;
  insertText(text: string): Promise<void>;
  loadUrl(url: string): Promise<void>;
  currentUrl(): string;
  title(): string;
  consoleEntries(): { level: string; message: string; url?: string; line?: number }[];
};

const SNAPSHOT_LIMIT = 12_000;
const NETWORK_LIMIT = 80;

/**
 * Runs in the page: tags visible interactive elements with `data-emdash-ref` and returns
 * an outline (headings, a text excerpt, and one line per element with its ref).
 */
const SNAPSHOT_SCRIPT = `(() => {
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick]';
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const textOf = (el) => el.innerText || el.textContent || '';
  const clip = (text, max) => {
    const t = (text || '').replace(/\\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  };
  const label = (el) => clip(
    el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el) ||
    el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '', 80);
  document.querySelectorAll('[data-emdash-ref]').forEach((el) => el.removeAttribute('data-emdash-ref'));
  const lines = [];
  lines.push('Title: ' + document.title, 'URL: ' + location.href, '');
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 30);
  if (headings.length) {
    lines.push('Headings:');
    for (const h of headings) lines.push('  ' + '#'.repeat(Number(h.tagName[1])) + ' ' + clip(textOf(h), 100));
    lines.push('');
  }
  lines.push('Elements:');
  let n = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el) || n >= 300) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-emdash-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
    const parts = ['[' + ref + ']', role];
    const text = label(el);
    if (text) parts.push(JSON.stringify(text));
    if (tag === 'input') parts.push('type=' + (el.type || 'text'));
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.value && el.type !== 'password') parts.push('value=' + JSON.stringify(clip(el.value, 60)));
    if (el.disabled) parts.push('disabled');
    if (el.checked) parts.push('checked');
    if (tag === 'a' && el.getAttribute('href')) parts.push('href=' + clip(el.getAttribute('href'), 80));
    lines.push('  ' + parts.join(' '));
  }
  lines.push('', 'Text:', clip(document.body ? textOf(document.body) : '', 3000));
  return lines.join('\\n');
})()`;

/** Scrolls the ref into view and returns its center in page (CSS) pixels. */
const centerScript = (ref: string) => `(() => {
  const el = document.querySelector('[data-emdash-ref=${JSON.stringify(ref)}]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

/** Focuses the ref and selects its content so typed text replaces it. */
const focusScript = (ref: string) => `(() => {
  const el = document.querySelector('[data-emdash-ref=${JSON.stringify(ref)}]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) document.execCommand('selectAll');
  return true;
})()`;

const NETWORK_SCRIPT = `(() => {
  const entries = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
  return entries.slice(-${NETWORK_LIMIT}).map((e) => ({
    url: e.name,
    type: e.initiatorType || e.entryType,
    status: e.responseStatus || 0,
    ms: Math.round(e.duration),
  }));
})()`;

/** Electron key codes for the names agents tend to use. */
const KEY_ALIASES: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
};

function keyCode(key: string): string {
  return KEY_ALIASES[key.toLowerCase()] ?? key;
}

const staleRef = (ref: string) =>
  new Error(`No element [${ref}] on the page; take a new browser_snapshot`);

export async function runBrowserOp(
  browser: AutomatableBrowser,
  op: BrowserOp
): Promise<AgentControlResult> {
  switch (op.op) {
    case 'open': {
      await browser.loadUrl(op.url);
      return { text: `Opened ${browser.currentUrl()} — "${browser.title()}"` };
    }
    case 'snapshot': {
      const text = String(await browser.executeJavaScript(SNAPSHOT_SCRIPT));
      return {
        text:
          text.length > SNAPSHOT_LIMIT ? `${text.slice(0, SNAPSHOT_LIMIT)}\n…(truncated)` : text,
      };
    }
    case 'click': {
      const point = (await browser.executeJavaScript(centerScript(op.ref))) as {
        x: number;
        y: number;
      } | null;
      if (!point) throw staleRef(op.ref);
      for (const type of ['mouseDown', 'mouseUp'] as const) {
        browser.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }
      return { text: `Clicked [${op.ref}]` };
    }
    case 'type': {
      if (!(await browser.executeJavaScript(focusScript(op.ref)))) throw staleRef(op.ref);
      await browser.insertText(op.text);
      if (op.submit) pressKey(browser, 'Enter');
      return { text: `Typed into [${op.ref}]${op.submit ? ' and pressed Enter' : ''}` };
    }
    case 'press': {
      pressKey(browser, op.key);
      return { text: `Pressed ${op.key}` };
    }
    case 'screenshot': {
      const png = await browser.capturePng();
      return {
        text: `Screenshot of ${browser.currentUrl()} (${png.width}×${png.height})`,
        image: { mimeType: 'image/png', data: png.dataUrl.replace(/^data:image\/png;base64,/, '') },
      };
    }
    case 'console': {
      const entries = browser.consoleEntries().slice(-60);
      if (entries.length === 0) return { text: 'No console messages.' };
      return {
        text: entries
          .map(
            (entry) =>
              `[${entry.level}] ${entry.message}${entry.url ? ` (${entry.url}${entry.line ? `:${entry.line}` : ''})` : ''}`
          )
          .join('\n'),
      };
    }
    case 'network': {
      const entries = (await browser.executeJavaScript(NETWORK_SCRIPT)) as {
        url: string;
        type: string;
        status: number;
        ms: number;
      }[];
      if (entries.length === 0) return { text: 'No requests recorded for this page.' };
      return {
        text: entries.map((e) => `${e.status || '—'} ${e.type} ${e.ms}ms ${e.url}`).join('\n'),
      };
    }
  }
}

function pressKey(browser: AutomatableBrowser, key: string): void {
  const code = keyCode(key);
  browser.sendInputEvent({ type: 'keyDown', keyCode: code });
  if (code === 'Enter' || code.length === 1) {
    browser.sendInputEvent({ type: 'char', keyCode: code === 'Enter' ? '\r' : code });
  }
  browser.sendInputEvent({ type: 'keyUp', keyCode: code });
}
