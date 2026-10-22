import { action, computed, makeObservable, observable, reaction, untracked } from 'mobx';
import { PaneStore } from '@core/primitives/workbench-shell/browser/tabs/pane-store';
import type { OpenTarget, TabViewContext } from './core/tab-provider';
import type {
  AnyTabProvider,
  KindOf,
  OpenArgsOf,
  TabOpenOptions,
  TabRegistry,
} from './core/tab-provider-registry';
import { parsePaneDropTargetId, type SplitSide } from './pane-drop-target';
import {
  adjacentPaneId,
  horizontalLayout,
  insertPaneInLayout,
  layoutPaneIds,
  neighborPaneId,
  normalizeLayout,
  removePaneFromLayout,
  splitWouldDuplicateSinglePane,
  type PaneLayoutNode,
} from './pane-layout-tree';
import type {
  PaneLayoutSnapshotMemento,
  TabGroupsSnapshot,
  TabManagerSnapshot,
} from './persistence';

const MAX_PANE_COUNT = 8;

/** Every pane appears exactly once in the layout and nothing else does. */
function layoutMatchesPanes(layout: PaneLayoutNode, paneIds: readonly string[]): boolean {
  const layoutIds = layoutPaneIds(layout);
  const layoutSet = new Set(layoutIds);
  const paneSet = new Set(paneIds);
  return (
    layoutIds.length === paneIds.length &&
    layoutSet.size === layoutIds.length &&
    paneSet.size === paneIds.length &&
    layoutIds.every((paneId) => paneSet.has(paneId)) &&
    paneIds.every((paneId) => layoutSet.has(paneId))
  );
}

export interface Pane<R extends TabRegistry = TabRegistry> {
  paneId: string;
  pane: PaneStore<R>;
}

export interface PaneDropDestination {
  paneId: string;
  insertBeforeTabId?: string;
}

/**
 * Owns the ordered array of per-pane PaneStore instances and the active
 * pane. Pixel sizes are library-owned (sync contract): the split-pane view
 * persists them through the shared layout storage, never through this store.
 *
 * Cross-pane concerns handled here:
 * - mount:'single' cardinality — at most one tab per dedupKey across ALL panes
 * - Tab move (detachTab + adoptEntry) — resource survives unchanged, no lifecycle calls
 * - target routing — 'active', 'left', 'right', { paneId }
 */
export class PaneLayoutStore<R extends TabRegistry = TabRegistry> {
  readonly groups: Pane<R>[] = [];
  /** Nested splits. `groups` stays the flat list of panes, in tree order. */
  root: PaneLayoutNode;
  activePaneId: string;

  /**
   * True when the owning task view is the currently active route.
   * Stored as an observable.box so it is reactive before makeObservable runs,
   * allowing the per-pane onActivate reactions (fireImmediately) to track it
   * correctly during pane construction.
   */
  private readonly _isViewActiveBox = observable.box(false);

  /** Expose as a plain getter for external consumers (e.g. tests, VM). */
  get isViewActive(): boolean {
    return this._isViewActiveBox.get();
  }

  private readonly _registry: R;
  private readonly _ctx: TabViewContext;
  private readonly _snapshotMemento: PaneLayoutSnapshotMemento | undefined;
  private _persistDisposer: (() => void) | null = null;
  private readonly _autoCloseDisposers = new Map<string, () => void>();
  private readonly _onActiveTabChange: ((tabId: string | undefined) => void) | undefined;
  private readonly _onPaneDestroyed: ((paneId: string) => void) | undefined;
  private readonly _activeTabDisposer: () => void;

  constructor(
    registry: R,
    ctx: TabViewContext,
    snapshotMemento?: PaneLayoutSnapshotMemento,
    opts?: {
      onActiveTabChange?: (tabId: string | undefined) => void;
      /**
       * Called when a pane group is destroyed (user close or auto-close), so
       * the owner can drop the group's persisted layout-storage entries. Not
       * called for the fresh constructor pane replaced during snapshot
       * restore, nor on dispose (the view is going away, not the groups).
       */
      onPaneDestroyed?: (paneId: string) => void;
    }
  ) {
    this._registry = registry;
    this._ctx = ctx;
    this._snapshotMemento = snapshotMemento;
    this._onActiveTabChange = opts?.onActiveTabChange;
    this._onPaneDestroyed = opts?.onPaneDestroyed;

    const initial = this._createPane();
    this.groups.push(initial);
    this.root = { kind: 'pane', paneId: initial.paneId };
    this.activePaneId = initial.paneId;

    makeObservable(this, {
      groups: observable,
      root: observable.ref,
      activePaneId: observable,
      isViewActive: computed,
      focusedPane: computed,
      canInsertPane: computed,
      splitRight: action,
      splitDown: action,
      insertPane: action,
      closePane: action,
      moveTab: action,
      handleDragEnd: action,
      materializeDropDestination: action,
      setActiveGroup: action,
      setViewActive: action,
      restoreSnapshot: action,
      open: action,
      takeTabsForTransfer: action,
      receiveTabs: action,
    });

    // Push focused pane's active tab changes to the history callback.
    this._activeTabDisposer = reaction(
      () => this.focusedPane.resolvedActiveTabId,
      (tabId) => this._onActiveTabChange?.(tabId),
      { fireImmediately: true }
    );
  }

  setViewActive(active: boolean): void {
    this._isViewActiveBox.set(active);
  }

  get focusedPane(): PaneStore<R> {
    return this.groups.find((g) => g.paneId === this.activePaneId)?.pane ?? this.groups[0].pane;
  }

  get canInsertPane(): boolean {
    return this.groups.length < MAX_PANE_COUNT;
  }

  splitRight(): void {
    this._splitToward('right');
  }

  splitDown(): void {
    this._splitToward('bottom');
  }

  insertPane(relativeToPaneId: string, side: SplitSide): string | undefined {
    if (!this.canInsertPane) return undefined;
    if (!this.groups.some((group) => group.paneId === relativeToPaneId)) return undefined;

    const newGroup = this._createPane();
    this.groups.push(newGroup);
    this.root = insertPaneInLayout(
      this.root,
      relativeToPaneId,
      side,
      newGroup.paneId,
      crypto.randomUUID()
    );
    this._orderGroups();
    return newGroup.paneId;
  }

  /**
   * Takes tabs out of a pane (all of them when `tabIds` is omitted) to show them in
   * another window. Null when the pane has none of them.
   */
  takeTabsForTransfer(paneId: string, tabIds?: readonly string[]): TabManagerSnapshot | null {
    const pane = this.groups.find((group) => group.paneId === paneId)?.pane;
    if (!pane) return null;
    const snapshot = pane.takeForTransfer(tabIds ?? [...pane.tabOrder]);
    return snapshot.tabs.length > 0 ? snapshot : null;
  }

  /** Adds tabs coming back from another window: to `paneId` when it still exists. */
  receiveTabs(groups: readonly Partial<TabManagerSnapshot>[], paneId?: string): void {
    const target =
      this.groups.find((group) => group.paneId === paneId) ??
      this.groups.find((group) => group.paneId === this.activePaneId) ??
      this.groups[0];
    if (!target) return;
    for (const group of groups) target.pane.receiveTransferred(group);
    this.activePaneId = target.paneId;
  }

  closePane(paneId: string): void {
    if (this.groups.length <= 1) return;

    const closing = this.groups.find((group) => group.paneId === paneId);
    if (!closing) return;
    const neighbor = neighborPaneId(this.root, paneId);

    this._autoCloseDisposers.get(paneId)?.();
    this._autoCloseDisposers.delete(paneId);

    closing.pane.dispose();
    this.root = removePaneFromLayout(this.root, paneId);
    this.groups.splice(
      this.groups.findIndex((group) => group.paneId === paneId),
      1
    );
    this._orderGroups();

    if (this.activePaneId === paneId) {
      this.activePaneId =
        neighbor && this.groups.some((group) => group.paneId === neighbor)
          ? neighbor
          : (this.groups[0]?.paneId ?? paneId);
    }

    this._onPaneDestroyed?.(paneId);
  }

  /**
   * Moves a tab between panes by detaching it (no dispose) and adopting it
   * in the target pane (no initialize). The resource instance is unchanged.
   */
  moveTab(tabId: string, fromPaneId: string, toPaneId: string, insertBeforeTabId?: string): void {
    if (fromPaneId === toPaneId) return;
    const fromGroup = this.groups.find((g) => g.paneId === fromPaneId);
    const toGroup = this.groups.find((g) => g.paneId === toPaneId);
    if (!fromGroup || !toGroup) return;

    const detached = fromGroup.pane.detachTab(tabId);
    if (!detached) return;

    toGroup.pane.adoptEntry(detached.entry, detached.resource, {
      insertBeforeTabId,
      activate: true,
    });
    this.activePaneId = toPaneId;
  }

  handleDragEnd(draggedTabId: string, overId: string): void {
    const fromGroup = this.groups.find((g) => g.pane.entries.has(draggedTabId));
    if (!fromGroup) return;

    const destination = this.materializeDropDestination(overId, draggedTabId);
    if (!destination) return;

    if (destination.paneId === fromGroup.paneId) {
      const fromTabIds = fromGroup.pane.resolvedTabs.map((t) => t.tabId);
      const fromIdx = fromTabIds.indexOf(draggedTabId);
      if (fromIdx === -1) return;
      const toIdx = destination.insertBeforeTabId
        ? fromTabIds.indexOf(destination.insertBeforeTabId)
        : fromTabIds.length - 1;
      if (toIdx !== -1) fromGroup.pane.reorderTabs(fromIdx, toIdx);
      return;
    }

    this.moveTab(draggedTabId, fromGroup.paneId, destination.paneId, destination.insertBeforeTabId);
  }

  canSplitAt(targetPaneId: string, side: SplitSide, sourceTabId?: string): boolean {
    if (!this.canInsertPane) return false;
    if (!this.groups.some((group) => group.paneId === targetPaneId)) return false;

    const fromGroup = sourceTabId
      ? this.groups.find((group) => group.pane.entries.has(sourceTabId))
      : undefined;
    if (!fromGroup || fromGroup.pane.tabOrder.length !== 1) return true;

    return !splitWouldDuplicateSinglePane(this.root, fromGroup.paneId, targetPaneId, side);
  }

  /**
   * Materializes one pane destination for a DnD target. Split targets create the
   * pane here, keeping creation, cap fallback, and no-op policy in one module.
   */
  materializeDropDestination(overId: string, sourceTabId?: string): PaneDropDestination | null {
    const paneTarget = parsePaneDropTargetId(overId);
    if (!paneTarget) {
      const tabGroup = this.groups.find((group) => group.pane.entries.has(overId));
      return tabGroup ? { paneId: tabGroup.paneId, insertBeforeTabId: overId } : null;
    }

    const targetExists = this.groups.some((group) => group.paneId === paneTarget.paneId);
    if (!targetExists) return null;
    if (paneTarget.kind !== 'split') return { paneId: paneTarget.paneId };

    const sourcePaneId = sourceTabId
      ? this.groups.find((group) => group.pane.entries.has(sourceTabId))?.paneId
      : undefined;
    if (!this.canSplitAt(paneTarget.paneId, paneTarget.side, sourceTabId)) {
      return this.canInsertPane || paneTarget.paneId === sourcePaneId
        ? null
        : { paneId: paneTarget.paneId };
    }

    const newPaneId = this.insertPane(paneTarget.paneId, paneTarget.side);
    return newPaneId ? { paneId: newPaneId } : null;
  }

  setActiveGroup(paneId: string): void {
    if (this.groups.some((g) => g.paneId === paneId)) {
      this.activePaneId = paneId;
    }
  }

  /**
   * The single public open entry point.
   *
   * `kind` selects the provider; `args` are the domain open-args (the "searchParams");
   * `config` carries engine routing flags:
   *   preview      – open as a preview tab (replaced on next preview open)
   *   overrideState – when single-mount hit, replace the existing tab's state
   *   target       – which pane to open into ('active' | 'left' | 'right' | 'up' | 'down' | {paneId})
   *   background   – open without activating the tab or its pane
   *
   * For single-mount providers, scans all panes for an existing dedupKey match
   * and focuses it (with optional state override) instead of opening a new tab.
   * When callers provide an explicit pane target, the existing tab is moved
   * there so drag/drop placement intent is preserved without reinitializing
   * the resource.
   *
   * For multi providers, routes directly to the target pane.
   */
  open<K extends KindOf<R>>(kind: K, args: OpenArgsOf<R, K>, config?: TabOpenOptions): void;
  /** Untyped overload used internally (handles, fallback from unknown registries). */
  open(kind: string, args: Record<string, unknown>, config?: TabOpenOptions): void;
  open(kind: string, args: Record<string, unknown>, config?: TabOpenOptions): void {
    const previewFlag = !!config?.preview;
    const overrideStateFlag = !!config?.overrideState;
    const backgroundFlag = !!config?.background;
    const resolvedTarget: OpenTarget = config?.target ?? 'active';
    const explicitTargetPaneId =
      typeof resolvedTarget === 'object' && 'paneId' in resolvedTarget
        ? resolvedTarget.paneId
        : undefined;

    if (!this._registry.has(kind)) {
      console.warn(`[PaneLayoutStore] Unknown tab kind: ${kind}`);
      return;
    }
    const def = this._registry.get(kind) as AnyTabProvider;

    // Compute initial state via onBeforeOpen or fall back to args directly.
    const initialState: unknown = def.onBeforeOpen
      ? def.onBeforeOpen(args as never, this._ctx)
      : (args as unknown);
    if (initialState === null) return; // aborted by onBeforeOpen

    // Single-mount: check ALL panes for an existing resourceKey match.
    if ((def.mount ?? 'multi') === 'single') {
      const key = def.resourceKey(initialState as never);
      for (const g of this.groups) {
        const existing = g.pane.findSingleMountEntry(kind, key);
        if (existing) {
          const explicitTargetGroup = explicitTargetPaneId
            ? this.groups.find((group) => group.paneId === explicitTargetPaneId)
            : undefined;
          if (explicitTargetGroup && explicitTargetGroup.paneId !== g.paneId) {
            if (!previewFlag) existing.isPreview = false;
            if (overrideStateFlag) existing.state = initialState;
            this.moveTab(existing.tabId, g.paneId, explicitTargetGroup.paneId);
            return;
          }

          if (!previewFlag) existing.isPreview = false;
          if (overrideStateFlag) existing.state = initialState;
          if (!backgroundFlag) {
            this.setActiveGroup(g.paneId);
            g.pane.setActiveTab(existing.tabId);
          }
          return;
        }
      }
    }

    // Route to the target pane.
    const targetPane = this._resolveTargetPane(resolvedTarget);
    targetPane.openWithState(kind, initialState, {
      isPreview: previewFlag,
      overrideState: overrideStateFlag,
      background: backgroundFlag,
    });
  }

  /** Returns true if any pane has a tab of the given kind + resourceKey open. */
  isOpen(kind: string, key: string): boolean {
    return this.groups.some((g) => g.pane.hasOpenKey(kind, key));
  }

  /** Returns true if the active tab in the focused pane matches kind + resourceKey. */
  isActiveInFocusedPane(kind: string, key: string): boolean {
    return this.focusedPane.activeMatches(kind, key);
  }

  /** Returns true if any pane's active tab matches kind + resourceKey. */
  isActiveInAnyPane(kind: string, key: string): boolean {
    return this.groups.some((g) => g.pane.activeMatches(kind, key));
  }

  get snapshot(): TabGroupsSnapshot {
    return {
      groups: this.groups.map((g) => ({
        groupId: g.paneId,
        tabManager: g.pane.snapshot,
      })),
      activeGroupId: this.activePaneId,
      layout: this.root,
    };
  }

  restoreSnapshot(snapshot: TabGroupsSnapshot): void {
    for (let i = 1; i < this.groups.length; i++) {
      this.groups[i].pane.dispose();
    }
    this.groups.splice(0, this.groups.length);

    const restoredGroups = snapshot.groups.filter(
      (group, index) =>
        snapshot.groups.findIndex((other) => other.groupId === group.groupId) === index
    );
    for (const g of restoredGroups) {
      const pane = this._createPaneStore(g.groupId);
      pane.restoreSnapshot(g.tabManager);
      this.groups.push({ paneId: g.groupId, pane });
      this._registerAutoClose(g.groupId, pane);
    }

    const paneIds = restoredGroups.map((group) => group.groupId);
    const layout = snapshot.layout ? normalizeLayout(snapshot.layout) : null;
    this.root = layout && layoutMatchesPanes(layout, paneIds) ? layout : horizontalLayout(paneIds);
    this._orderGroups();

    this.activePaneId = paneIds.includes(snapshot.activeGroupId)
      ? snapshot.activeGroupId
      : (paneIds[0] ?? this.activePaneId);
  }

  /**
   * Restores the persisted snapshot from the memento, resolving true when a
   * stored layout was applied. Awaiting the memento's `ready` makes restore
   * ordering a store guarantee: a hydrate() racing a slow memento hydration
   * waits for the stored value instead of silently skipping the restore.
   */
  async hydrate(): Promise<boolean> {
    const memento = this._snapshotMemento;
    if (!memento) return false;
    await memento.ready;
    if (!memento.hasStoredValue) return false;
    const snapshot = memento.read();
    if (snapshot.groups.length === 0) return false;
    this.restoreSnapshot(snapshot);
    return true;
  }

  /** Starts persisting snapshot changes. Call after hydrate() so the baseline
   * does not trigger a spurious save. */
  startPersistence(): void {
    const memento = this._snapshotMemento;
    if (!memento) return;
    this._persistDisposer?.();
    this._persistDisposer = memento.autoPersist(() => {
      const snapshot = this.snapshot;
      // Carry document fields the store does not own (the schema version tag)
      // without tracking the memento's own value in this reaction.
      return { ...untracked(() => memento.read()), ...snapshot };
    });
  }

  stopPersistence(): void {
    this._persistDisposer?.();
    this._persistDisposer = null;
  }

  dispose(): void {
    this._activeTabDisposer();
    this.stopPersistence();
    for (const disposer of this._autoCloseDisposers.values()) {
      disposer();
    }
    this._autoCloseDisposers.clear();
    for (const { pane } of this.groups) {
      pane.dispose();
    }
  }

  /**
   * Resolve a target to an existing or newly-split PaneStore.
   * 'active' => focused pane
   * 'right' / 'left' / 'down' / 'up' => the neighbor in that direction, or a new pane
   * { paneId } => specific pane (falls back to focused if not found)
   */
  private _resolveTargetPane(target: OpenTarget): PaneStore<R> {
    if (target === 'active') return this.focusedPane;

    if (typeof target === 'object' && 'paneId' in target) {
      return this.groups.find((g) => g.paneId === target.paneId)?.pane ?? this.focusedPane;
    }

    const side: SplitSide =
      target === 'left'
        ? 'left'
        : target === 'right'
          ? 'right'
          : target === 'up'
            ? 'top'
            : 'bottom';
    const neighbor = adjacentPaneId(this.root, this.activePaneId, side);
    if (neighbor) {
      this.activePaneId = neighbor;
      return this.groups.find((group) => group.paneId === neighbor)?.pane ?? this.focusedPane;
    }

    if (!this.canInsertPane) return this.focusedPane;
    const newPaneId = this.insertPane(this.activePaneId, side);
    if (!newPaneId) return this.focusedPane;
    this.activePaneId = newPaneId;
    return this.groups.find((group) => group.paneId === newPaneId)?.pane ?? this.focusedPane;
  }

  private _splitToward(side: SplitSide): void {
    if (!this.canInsertPane) return;
    const sourceGroup =
      this.groups.find((group) => group.paneId === this.activePaneId) ?? this.groups[0];
    if (!sourceGroup || sourceGroup.pane.tabOrder.length < 2) return;
    const activeTabId = sourceGroup.pane.resolvedActiveTabId;
    if (!activeTabId) return;
    const newPaneId = this.insertPane(sourceGroup.paneId, side);
    if (!newPaneId) return;
    this.moveTab(activeTabId, sourceGroup.paneId, newPaneId);
  }

  private _orderGroups(): void {
    const byId = new Map(this.groups.map((group) => [group.paneId, group]));
    const ordered = layoutPaneIds(this.root).flatMap((paneId) => {
      const group = byId.get(paneId);
      return group ? [group] : [];
    });
    this.groups.splice(0, this.groups.length, ...ordered);
  }

  private _createPane(): Pane<R> {
    const paneId = crypto.randomUUID();
    const pane = this._createPaneStore(paneId);
    this._registerAutoClose(paneId, pane);
    return { paneId, pane };
  }

  private _createPaneStore(_paneId: string): PaneStore<R> {
    return new PaneStore<R>(this._registry, this._ctx, {
      layoutOpener: (kind, args, config) => this.open(kind, args, config),
      isViewActive: () => this._isViewActiveBox.get(),
    });
  }

  private _registerAutoClose(paneId: string, pane: PaneStore<R>): void {
    const disposer = reaction(
      () => pane.tabOrder.length,
      (length) => {
        if (length === 0 && this.groups.length > 1) {
          this.closePane(paneId);
        }
      }
    );
    this._autoCloseDisposers.set(paneId, disposer);
  }
}
