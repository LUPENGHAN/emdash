import { isObservable } from 'mobx';
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

describe('PaneLayoutStore tab transfer', () => {
  function storeWithTabs() {
    const events: string[] = [];
    const registry = createTabRegistry([
      {
        kind: 'test',
        resourceKey: (state: { id: string }) => state.id,
        initialize: (entry: { state: { id: string } }) => {
          events.push(`init:${entry.state.id}`);
          return {
            dispose: () => events.push(`dispose:${entry.state.id}`),
            onClose: () => events.push(`close:${entry.state.id}`),
          };
        },
        dispose() {},
        TabBarItem: () => null,
        TabBarItemDragPreview: () => null,
        TabContent: () => null,
      },
    ]);
    const store = new PaneLayoutStore(registry, { viewId: 'test-view' });
    stores.push(store);
    const tab = (id: string) => ({ kind: 'test', tabId: `t-${id}`, isPreview: false, id });
    store.restoreSnapshot({
      groups: [{ groupId: 'a', tabManager: { tabs: [tab('1'), tab('2')], activeTabId: 't-2' } }],
      activeGroupId: 'a',
    });
    events.length = 0;
    return { store, events, tab };
  }

  it('takes tabs out without running their close hooks', () => {
    const { store, events } = storeWithTabs();
    const taken = store.takeTabsForTransfer('a', ['t-2']);
    expect(taken?.tabs.map((tab) => tab.tabId)).toEqual(['t-2']);
    expect(taken?.activeTabId).toBe('t-2');
    expect(events).toEqual(['dispose:2']);
    expect(store.groups[0]?.pane.tabOrder).toEqual(['t-1']);
    expect(store.takeTabsForTransfer('a', ['missing'])).toBeNull();
  });

  it('takes tabs out as plain data another window can receive', () => {
    const { store, tab } = storeWithTabs();
    store.receiveTabs([{ tabs: [{ ...tab('5'), ref: { kind: 'branch', name: 'main' } }] }], 'a');
    const taken = store.takeTabsForTransfer('a', ['t-5']);
    expect(isObservable((taken?.tabs[0] as { ref?: object } | undefined)?.ref)).toBe(false);
    expect(structuredClone(taken)).toEqual(taken);
  });

  it('receives tabs into the given pane, skipping ones it already shows', () => {
    const { store, events, tab } = storeWithTabs();
    store.receiveTabs([{ tabs: [tab('1'), tab('3')], activeTabId: 't-3' }], 'a');
    const pane = store.groups[0]!.pane;
    expect(pane.tabOrder).toEqual(['t-1', 't-2', 't-3']);
    expect(pane.activeTabId).toBe('t-3');
    expect(events).toEqual(['init:3']);
  });

  it('falls back to the focused pane when the original one is gone', () => {
    const { store, tab } = storeWithTabs();
    store.receiveTabs([{ tabs: [tab('4')] }], 'closed-pane');
    expect(store.groups[0]?.pane.tabOrder).toContain('t-4');
  });
});

describe('PaneLayoutStore.open in the background', () => {
  function storeWithActiveTab() {
    const store = createStore();
    store.open('test', { id: 'chat' });
    return store;
  }

  it('adds the tab without changing the active tab', () => {
    const store = storeWithActiveTab();
    const before = store.focusedPane.resolvedActiveTabId;
    store.open('test', { id: 'page' }, { preview: false, background: true });
    const pane = store.focusedPane;
    expect(pane.resolvedTabs).toHaveLength(2);
    expect(pane.resolvedTabs.find((tab) => tab.isActive)?.tabId).toBe(before);
    expect(pane.resolvedActiveTabId).toBe(before);
  });

  it('activates the new tab when not opened in the background', () => {
    const store = storeWithActiveTab();
    store.open('test', { id: 'page' }, { preview: false });
    const pane = store.focusedPane;
    expect(pane.activeEntry?.state).toEqual({ id: 'page' });
  });
});
