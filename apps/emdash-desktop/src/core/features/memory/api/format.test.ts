import { describe, expect, it } from 'vitest';
import { formatMemoryList, formatMemoryRecord } from './format';
import { MEMORY_LIST_WITH_DETAIL, type MemoryRecord } from './types';

function record(id: string, createdAt: number, detail?: string): MemoryRecord {
  return {
    id,
    title: `title ${id}`,
    detail,
    source: { kind: 'user' },
    createdAt,
    updatedAt: createdAt,
  };
}

describe('formatMemoryList', () => {
  it('lists newest first and keeps the body only on the newest rows', () => {
    const items = Array.from({ length: MEMORY_LIST_WITH_DETAIL + 1 }, (_, index) =>
      record(`n${index}`, index + 1, `body ${index}`)
    );
    const text = formatMemoryList(items);
    expect(text.startsWith('n40 [1970-01-01] title n40\n  body 40')).toBe(true);
    expect(text).toContain('n0 [1970-01-01] title n0');
    expect(text).not.toContain('body 0');
    expect(text).toContain('  body 1');
  });

  it('indents a multiline body and prints one record in full', () => {
    expect(formatMemoryList([record('a', 2, 'new body\nsecond')])).toContain(
      '  new body\n  second'
    );
    expect(formatMemoryList([])).toBe('No decisions.');
    expect(formatMemoryRecord(record('a', 0, 'why'))).toBe(
      'a [1970-01-01T00:00:00.000Z] title a\n\nwhy'
    );
  });
});
