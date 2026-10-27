import { describe, expect, it } from 'vitest';
import {
  canChangeParent,
  childProgress,
  parentChoices,
  requirementTaskPrompt,
  visibleRequirementRows,
} from './requirement-tree';
import type { Requirement } from './types';

function item(id: string, createdAt: number, extra: Partial<Requirement> = {}): Requirement {
  return {
    id,
    title: id,
    status: 'open',
    source: { kind: 'user' },
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

const parent = item('parent', 10);
const older = item('older', 20, { parentId: 'parent' });
const newer = item('newer', 30, { parentId: 'parent', status: 'done' });
const doneParent = item('done-parent', 5, { status: 'done' });
const stillOpen = item('still-open', 40, { parentId: 'done-parent' });
const loose = item('loose', 50);
const dangling = item('dangling', 60, { parentId: 'missing' });
const items = [parent, older, newer, doneParent, stillOpen, loose, dangling];

describe('visibleRequirementRows', () => {
  it('nests open sub-requirements and keeps a done parent that still has open work', () => {
    expect(visibleRequirementRows(items, 'open').map(row)).toEqual([
      ['dangling', 0],
      ['loose', 0],
      ['parent', 0],
      ['older', 1],
      ['done-parent', 0],
      ['still-open', 1],
    ]);
    expect(childProgress(parent, items)).toEqual({ open: 1, total: 2 });
    expect(childProgress(doneParent, items)).toEqual({ open: 1, total: 1 });
    expect(childProgress(loose, items)).toBeNull();
  });

  it('shows an open parent as a header for its done sub-requirements', () => {
    const rows = visibleRequirementRows(items, 'done');
    expect(rows.map(row)).toEqual([
      ['done-parent', 0],
      ['parent', 0],
      ['newer', 1],
    ]);
    expect(rows.find((entry) => entry.item.id === 'parent')?.item.status).toBe('open');
  });

  it('orders sub-requirements oldest first', () => {
    const first = item('first', 2, { parentId: 'parent' });
    const second = item('second', 3, { parentId: 'parent' });
    expect(visibleRequirementRows([parent, second, first], 'open').map(row)).toEqual([
      ['parent', 0],
      ['first', 1],
      ['second', 1],
    ]);
  });
});

describe('parent choices and task prompts', () => {
  it('lets a child move, and keeps a parent with children where it is', () => {
    expect(canChangeParent(parent, items)).toBe(false);
    expect(parentChoices(parent, items)).toEqual([]);
    expect(canChangeParent(older, items)).toBe(true);
    expect(parentChoices(older, items).map((choice) => choice.id)).toEqual([
      'parent',
      'done-parent',
      'loose',
    ]);
    expect(canChangeParent(loose, [loose])).toBe(false);
  });

  it('adds unfinished sub-requirement titles to the task prompt', () => {
    const withDetail = item('parent', 10, { title: 'Parent', detail: 'why' });
    expect(requirementTaskPrompt(withDetail, [withDetail, older, newer])).toBe(
      'Parent\n\nwhy\n\n- older'
    );
    expect(requirementTaskPrompt(loose, [loose])).toBe('loose');
  });
});

function row(entry: { item: Requirement; depth: 0 | 1 }): [string, 0 | 1] {
  return [entry.item.id, entry.depth];
}
