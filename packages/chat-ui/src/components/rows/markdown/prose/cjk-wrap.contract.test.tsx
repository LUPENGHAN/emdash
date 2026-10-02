/**
 * cjk-wrap.contract.test.tsx — line breaking of Latin words inside Chinese text.
 *
 * A full-width opening bracket glues to the next character so it never ends a line;
 * that glued piece then counted as CJK, which may break between any two characters,
 * so the Latin word after the bracket broke after its first letter ("（b" / "rute
 * force）"). Patched in patches/@chenglou__pretext@0.0.8.patch.
 */

import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';
import { describe, expect, it } from 'vitest';

const FONT = '16px sans-serif';

/** Line breaks that fall between two Latin letters, at every width in the range. */
function breaksInsideWords(text: string): string[] {
  const prepared = prepareWithSegments(text, FONT);
  const found: string[] = [];
  for (let width = 80; width <= 480; width += 2) {
    const lines = layoutWithLines(prepared, width, 24).lines.map((line) => line.text);
    for (let i = 0; i + 1 < lines.length; i++) {
      if (/[A-Za-z]$/.test(lines[i]!) && /^[A-Za-z]/.test(lines[i + 1]!)) {
        found.push(`${width}px: "${lines[i]}" | "${lines[i + 1]}"`);
      }
    }
  }
  return found;
}

describe('Latin words in Chinese text', () => {
  it('keeps a word after a full-width opening bracket whole', () => {
    expect(breaksInsideWords('重试次数没有上限，存在被暴力破解的风险（brute force）。')).toEqual(
      []
    );
    expect(breaksInsideWords('他说「hello world」然后离开了这个房间，没有再回来过。')).toEqual([]);
  });

  it('still breaks between Chinese characters', () => {
    const prepared = prepareWithSegments(
      '这样处理之后登录成功率应该会明显提升同时风险也降低了',
      FONT
    );
    expect(layoutWithLines(prepared, 120, 24).lines.length).toBeGreaterThan(1);
  });
});
