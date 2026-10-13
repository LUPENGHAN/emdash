import { afterEach, describe, expect, it } from 'vitest';
import { createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';
import { layoutPaneIds } from './pane-layout-tree';
import type { TabGroupsSnapshot } from './persistence';

const stores: PaneLayoutStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function createStore() {
  const registry = createTabRegistry([
    {
      kind: 'test',
      resourceKey: (state: { id: string }) => state.id,
      initialize: () => ({ dispose() {} }),
      dispose() {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    },
  ]);
  const store = new PaneLayoutStore(registry, { viewId: 'test-view' });
  stores.push(store);
  return store;
}

function group(groupId: string): TabGroupsSnapshot['groups'][number] {
  return { groupId, tabManager: { tabs: [] } };
}

describe('PaneLayoutStore.restoreSnapshot', () => {
  it('falls back to a row when the saved layout repeats a pane', () => {
    const store = createStore();
    store.restoreSnapshot({
      groups: [group('a'), group('b')],
      activeGroupId: 'a',
      layout: {
        kind: 'split',
        id: 'root',
        orientation: 'vertical',
        children: [
          { kind: 'pane', paneId: 'a' },
          { kind: 'pane', paneId: 'a' },
        ],
      },
    });
    expect(store.root).toMatchObject({ kind: 'split', orientation: 'horizontal' });
    expect(layoutPaneIds(store.root)).toEqual(['a', 'b']);
  });

  it('keeps one pane per repeated group id', () => {
    const store = createStore();
    store.restoreSnapshot({
      groups: [group('a'), group('a'), group('b')],
      activeGroupId: 'b',
    });
    expect(store.groups.map((item) => item.paneId)).toEqual(['a', 'b']);
    expect(store.activePaneId).toBe('b');
  });

  it('flattens same-orientation nesting in a saved layout', () => {
    const store = createStore();
    store.restoreSnapshot({
      groups: [group('a'), group('b'), group('c')],
      activeGroupId: 'a',
      layout: {
        kind: 'split',
        id: 'root',
        orientation: 'horizontal',
        children: [
          { kind: 'pane', paneId: 'a' },
          {
            kind: 'split',
            id: 'nested',
            orientation: 'horizontal',
            children: [
              { kind: 'pane', paneId: 'b' },
              { kind: 'pane', paneId: 'c' },
            ],
          },
        ],
      },
    });
    expect(store.root).toEqual({
      kind: 'split',
      id: 'root',
      orientation: 'horizontal',
      children: [
        { kind: 'pane', paneId: 'a' },
        { kind: 'pane', paneId: 'b' },
        { kind: 'pane', paneId: 'c' },
      ],
    });
  });
});
