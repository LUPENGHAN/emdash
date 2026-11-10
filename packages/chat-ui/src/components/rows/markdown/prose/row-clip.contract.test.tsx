/**
 * row-clip.contract.test.tsx — rows must not clip their own text edge.
 *
 * Rows sit on a box that is exactly the text width. With paint containment, a
 * line that lands a fraction (or a hanging space) past that box lost the right
 * slice of its last glyph, which reads as "the last character is cut off". The
 * scroll container's `overflow-x: hidden` already clips the gutter, so rows only
 * need layout/style containment.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const MESSAGE = [
  '有参考价值，但更适合作为**验证范围和测试环境问题的提示**，不是这次修复的缺陷结论。',
  '',
  '- 报告称 3 个相关测试套件共 16 个测试通过；其中两个新增用例验证了录音期间播放器设置的音频模式。不过 `expo-audio` 被 mock，不能证明 iOS 录音不中断或 Android 后台通知正常消失，仍需真机验证。',
  '- `RecordingModule` 确实使用原生驱动的 `Animated`；报告里的 view-attachment 错误值得排查，但仅凭这条信息无法确定根因，也不能认定是真机问题。',
  '',
  'Unrelated issues P2, /workspace/src/screens/Console/RecordingModule.test.tsx:260: Broader validation encounters native Animated view-attachment errors in this test environment. 看看有没有参考价值',
].join('\n');

function turn(): TranscriptTurn {
  return {
    id: 'turn',
    seq: 0,
    initiator: 'agent',
    items: [{ kind: 'message', id: 'message', seq: 0, role: 'assistant', text: MESSAGE }],
  };
}

/** A content column that fills the host, so panes wider than the default cap are covered. */
const FULL_WIDTH = 'row-clip-full-width';

function mount(width: number) {
  const context = createChatContext();
  const state = createChatState(context, { uri: 'original' });
  state.transcript.history.seed([turn()]);
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:600px;`;
  document.body.append(host);

  const style = document.createElement('style');
  style.textContent = `.${FULL_WIDTH}{width:100%;max-width:none;}`;
  document.head.append(style);

  const view = createChatView({ context, state, parent: host, contentClass: FULL_WIDTH });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
    style.remove();
  });
  return { host };
}

/** Right edge of a fragment's painted glyphs, ignoring a hanging trailing space. */
function inkRight(span: HTMLElement): number {
  const node = span.firstChild;
  const box = span.getBoundingClientRect();
  if (!node || node.nodeType !== Node.TEXT_NODE) return box.right;
  const text = node.textContent ?? '';
  const visible = text.replace(/[ \t]+$/, '').length;
  if (visible === text.length) return box.right;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, visible);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 ? rect.right : box.right;
}

/** Glyphs painted past their row's right edge. */
function inkOverflow(host: HTMLElement): string[] {
  const found: string[] = [];
  for (const row of host.querySelectorAll<HTMLElement>('[data-chat-canvas] > div')) {
    const limit = row.getBoundingClientRect().right;
    for (const span of row.querySelectorAll<HTMLElement>('div > span')) {
      if (span.querySelector('span')) continue;
      if (!(span.textContent ?? '').trim()) continue;
      const overflow = inkRight(span) - limit;
      if (overflow > 0.01) {
        found.push(
          `${overflow.toFixed(2)}px past the row: "…${(span.textContent ?? '').slice(-24)}"`
        );
      }
    }
  }
  return found;
}

describe('transcript rows', () => {
  it('do not paint-contain their own text edge', async () => {
    const { host } = mount(700);
    await paint();
    await paint();
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-chat-canvas] > div'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Chromium reports paint containment as part of the `content` shorthand.
      expect(getComputedStyle(row).contain).not.toMatch(/paint|content/);
    }
  });

  it.each([1200.4, 900.7, 843.57, 700.3, 660.25, 620.6, 560.33, 480.5, 400.75, 340.15, 320])(
    'keep every glyph inside the row at %ipx',
    async (width) => {
      const { host } = mount(width);
      await paint();
      await paint();
      expect(inkOverflow(host)).toEqual([]);
    }
  );
});
