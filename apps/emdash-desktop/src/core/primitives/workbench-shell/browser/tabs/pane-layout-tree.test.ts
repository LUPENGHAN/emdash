import { describe, expect, it } from 'vitest';
import {
  adjacentPaneId,
  horizontalLayout,
  insertPaneInLayout,
  layoutPaneIds,
  normalizeLayout,
  removePaneFromLayout,
  splitWouldDuplicateSinglePane,
} from './pane-layout-tree';
import type { PaneLayoutNode } from './persistence';

describe('pane layout tree', () => {
  it('inserts to the right inside an existing horizontal row', () => {
    const root = horizontalLayout(['a', 'b']);
    const next = insertPaneInLayout(root, 'a', 'right', 'c', 'split-1');
    expect(layoutPaneIds(next)).toEqual(['a', 'c', 'b']);
  });

  it('wraps a pane in a vertical split when the parent is horizontal', () => {
    const root = horizontalLayout(['a', 'b']);
    const next = insertPaneInLayout(root, 'b', 'bottom', 'c', 'split-down');
    expect(layoutPaneIds(next)).toEqual(['a', 'b', 'c']);
    expect(next).toMatchObject({
      kind: 'split',
      orientation: 'horizontal',
      children: [
        { kind: 'pane', paneId: 'a' },
        {
          kind: 'split',
          id: 'split-down',
          orientation: 'vertical',
          children: [
            { kind: 'pane', paneId: 'b' },
            { kind: 'pane', paneId: 'c' },
          ],
        },
      ],
    });
  });

  it('collapses a split back to the remaining pane', () => {
    const root = insertPaneInLayout(horizontalLayout(['a']), 'a', 'bottom', 'b', 'down');
    expect(layoutPaneIds(removePaneFromLayout(root, 'b'))).toEqual(['a']);
  });

  it('splices a same-orientation split into its parent after a collapse', () => {
    const root: PaneLayoutNode = {
      kind: 'split',
      id: 'root',
      orientation: 'horizontal',
      children: [
        { kind: 'pane', paneId: 'a' },
        {
          kind: 'split',
          id: 'v',
          orientation: 'vertical',
          children: [
            { kind: 'pane', paneId: 'b' },
            {
              kind: 'split',
              id: 'h',
              orientation: 'horizontal',
              children: [
                { kind: 'pane', paneId: 'c' },
                { kind: 'pane', paneId: 'd' },
              ],
            },
          ],
        },
      ],
    };
    expect(removePaneFromLayout(root, 'b')).toEqual({
      kind: 'split',
      id: 'root',
      orientation: 'horizontal',
      children: [
        { kind: 'pane', paneId: 'a' },
        { kind: 'pane', paneId: 'c' },
        { kind: 'pane', paneId: 'd' },
      ],
    });
  });

  it('normalizes empty, single-child, and same-orientation splits', () => {
    expect(
      normalizeLayout({
        kind: 'split',
        id: 'root',
        orientation: 'vertical',
        children: [
          { kind: 'split', id: 'empty', orientation: 'horizontal', children: [] },
          {
            kind: 'split',
            id: 'single',
            orientation: 'horizontal',
            children: [{ kind: 'pane', paneId: 'a' }],
          },
          {
            kind: 'split',
            id: 'same',
            orientation: 'vertical',
            children: [
              { kind: 'pane', paneId: 'b' },
              { kind: 'pane', paneId: 'c' },
            ],
          },
        ],
      })
    ).toEqual({
      kind: 'split',
      id: 'root',
      orientation: 'vertical',
      children: [
        { kind: 'pane', paneId: 'a' },
        { kind: 'pane', paneId: 'b' },
        { kind: 'pane', paneId: 'c' },
      ],
    });
    expect(
      normalizeLayout({ kind: 'split', id: 'x', orientation: 'vertical', children: [] })
    ).toBeNull();
  });

  it('finds the adjacent pane through an ancestor split of the matching orientation', () => {
    const root: PaneLayoutNode = {
      kind: 'split',
      id: 'root',
      orientation: 'horizontal',
      children: [
        {
          kind: 'split',
          id: 'left',
          orientation: 'vertical',
          children: [
            { kind: 'pane', paneId: 'a' },
            { kind: 'pane', paneId: 'b' },
          ],
        },
        {
          kind: 'split',
          id: 'right',
          orientation: 'horizontal',
          children: [
            { kind: 'pane', paneId: 'c' },
            { kind: 'pane', paneId: 'd' },
          ],
        },
      ],
    };
    expect(adjacentPaneId(root, 'a', 'right')).toBe('c');
    expect(adjacentPaneId(root, 'b', 'right')).toBe('c');
    expect(adjacentPaneId(root, 'c', 'left')).toBe('a');
    expect(adjacentPaneId(root, 'a', 'bottom')).toBe('b');
    expect(adjacentPaneId(root, 'a', 'left')).toBeUndefined();
    expect(adjacentPaneId(root, 'c', 'bottom')).toBeUndefined();
  });

  it('treats a drop onto the pane that already sits on that edge as a no-op', () => {
    const root = horizontalLayout(['a', 'b']);
    expect(splitWouldDuplicateSinglePane(root, 'a', 'b', 'left')).toBe(true);
    expect(splitWouldDuplicateSinglePane(root, 'a', 'b', 'right')).toBe(false);
    expect(splitWouldDuplicateSinglePane(root, 'a', 'a', 'bottom')).toBe(true);
  });
});
