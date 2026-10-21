import { describe, expect, it } from 'vitest';
import { splitQuickEntry } from './quick-entry';
import { REQUIREMENT_TITLE_MAX } from './types';

describe('splitQuickEntry', () => {
  it('takes a single line as the title', () => {
    expect(splitQuickEntry('  Add dark mode  ')).toEqual({ title: 'Add dark mode' });
  });

  it('takes the other lines as the detail', () => {
    expect(splitQuickEntry('Add dark mode\nfollow the OS\n\nand a toggle')).toEqual({
      title: 'Add dark mode',
      detail: 'follow the OS\n\nand a toggle',
    });
  });

  it('ignores blank lines around the entry', () => {
    expect(splitQuickEntry('\n\n  Add dark mode\n  detail  \n\n')).toEqual({
      title: 'Add dark mode',
      detail: 'detail',
    });
  });

  it('returns null for blank text', () => {
    expect(splitQuickEntry('  \n\t\n ')).toBeNull();
  });

  it('moves what a long title loses to the start of the detail', () => {
    const long = `${'a'.repeat(REQUIREMENT_TITLE_MAX)}tail end`;
    expect(splitQuickEntry(`${long}\nmore`)).toEqual({
      title: 'a'.repeat(REQUIREMENT_TITLE_MAX),
      detail: 'tail end\nmore',
    });
  });
});
