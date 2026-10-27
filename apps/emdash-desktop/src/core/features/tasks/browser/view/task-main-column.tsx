import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  Resizable,
  useCollapsiblePanelBinding,
  useResizableDefaultLayout,
} from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  splitPanePanelId,
  taskPanelLayoutsMemento,
} from '@core/features/tasks/contributions/mementos';
import {
  isTerminalDrawerDragData,
  type TerminalDrawerDragData,
} from '@core/features/terminals/api/browser/task-terminal/terminal-drag';
import { TerminalsPanel } from '@core/features/terminals/contributions/browser/task-terminal/terminal-panel';
import { isPopoutWindow } from '@core/features/workbench/api/browser/popout-mode';
import { popOutTabs } from '@core/features/workbench/api/browser/popout/popout-actions';
import { taskTabWindowCommands } from '@core/features/workbench/api/browser/popout/popout-commands';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { PaneProvider } from '@core/features/workbench/contributions/browser/tabs/pane-provider';
import { createLayoutStorage, type MementoLayoutStorage } from '@core/primitives/mementos/browser';
import { PaneContent } from '@core/primitives/workbench-shell/browser/tabs/pane-content';
import { isPaneSplitDropTargetId } from '@core/primitives/workbench-shell/browser/tabs/pane-drop-target';
import type { Pane as PaneGroup } from '@core/primitives/workbench-shell/browser/tabs/pane-layout-store';
import { layoutSplitIds } from '@core/primitives/workbench-shell/browser/tabs/pane-layout-tree';
import type { PaneLayoutNode } from '@core/primitives/workbench-shell/browser/tabs/persistence';
import { TabWindowCommandsContext } from '@core/primitives/workbench-shell/browser/tabs/tab-bar/tab-context-menu';
import { TabDragPreview } from '@core/primitives/workbench-shell/browser/tabs/tab-bar/tab-drag-preview';
import { NewConversationTabButton } from '../new-conversation-tab-button';
import { PaneEmptyState } from '../pane-empty-state';

type ActiveDrag =
  | { kind: 'tab'; tabId: string }
  | { kind: 'terminal'; terminal: TerminalDrawerDragData };

// Drag-to-close threshold for the bottom drawer, in percent of the column.
// Below ~10% only the drawer tab bar and a row or two of terminal remain
// visible, so a drag settling there reads as intent to close rather than a
// resize. Deliberately under the drawer's old 15% resize floor, so every
// height the previous UI could persist stays a plain restore, never a close.
const TERMINAL_DRAWER_CLOSE_THRESHOLD = 10;

const collisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const splitZones = collisions.filter((collision) =>
    isPaneSplitDropTargetId(String(collision.id))
  );
  return splitZones.length > 0 ? splitZones : collisions;
};

export const TaskMainColumn = observer(function TaskMainColumn() {
  const taskView = useTaskComposition();
  const { paneLayout } = taskView;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  // One storage facade per composition. TaskMainColumn renders below the task
  // view's space.isHydrated gate, so synchronous reads are safe by contract.
  const layoutStorage = useMemo(
    () => createLayoutStorage(taskView.space, taskPanelLayoutsMemento),
    [taskView.space]
  );
  const drawerBinding = useCollapsiblePanelBinding({
    storageKey: 'task-main-vertical',
    storage: layoutStorage,
    panelIds: ['task-main-content', 'task-terminal-drawer'],
    collapsiblePanelId: 'task-terminal-drawer',
    orientation: 'vertical',
    open: taskView.isTerminalDrawerOpen,
    onCloseRequest: () => taskView.chrome.commands.closeTerminalDrawer(),
    closeThreshold: TERMINAL_DRAWER_CLOSE_THRESHOLD,
  });

  const handleDragStart = (event: DragStartEvent) => {
    const terminalDragData = event.active.data.current;
    if (isTerminalDrawerDragData(terminalDragData)) {
      setActiveDrag({ kind: 'terminal', terminal: terminalDragData });
      return;
    }
    setActiveDrag({ kind: 'tab', tabId: event.active.id as string });
    trackPointer();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    const pointer = stopTrackingPointer();
    // A tab dropped outside the window opens in a window of its own, there.
    if (
      pointer &&
      isOutsideWindow(pointer) &&
      !isTerminalDrawerDragData(event.active.data.current)
    ) {
      const tabId = event.active.id as string;
      const from = paneLayout.groups.find((group) => group.pane.entries.has(tabId));
      if (from && !isPopoutWindow()) {
        void popOutTabs(taskView, from.paneId, [tabId], { x: pointer.screenX, y: pointer.screenY });
      }
      return;
    }
    if (!event.over) return;

    const terminalDragData = event.active.data.current;
    if (isTerminalDrawerDragData(terminalDragData)) {
      const overId = String(event.over.id);
      const destination = paneLayout.materializeDropDestination(overId);
      if (!destination) return;
      paneLayout.setActiveGroup(destination.paneId);
      paneLayout.open(
        'terminal',
        { terminalId: terminalDragData.terminalId },
        { target: { paneId: destination.paneId } }
      );
      return;
    }

    paneLayout.handleDragEnd(event.active.id as string, event.over.id as string);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        stopTrackingPointer();
        setActiveDrag(null);
      }}
    >
      <Resizable.Group id="task-main-vertical" {...drawerBinding.groupProps}>
        <Resizable.Panel id="task-main-content" minSize="30%">
          <SplitPaneLayout storage={layoutStorage} />
        </Resizable.Panel>
        {/* Closed = panel AND handle unmounted (sync contract: never program
            the panels). Terminal content survives the unmount because each
            PTY session's xterm DOM is reparented to the off-screen host, not
            disposed (see usePty). */}
        {taskView.isTerminalDrawerOpen && (
          <>
            <Resizable.Handle />
            <Resizable.Panel
              {...drawerBinding.collapsiblePanelProps}
              defaultSize={drawerBinding.collapsiblePanelProps.defaultSize ?? '25%'}
            >
              <TerminalsPanel />
            </Resizable.Panel>
          </>
        )}
      </Resizable.Group>
      <DragOverlay dropAnimation={null}>
        {activeDrag?.kind === 'tab' ? (
          <TabDragPreview tabId={activeDrag.tabId} />
        ) : activeDrag?.kind === 'terminal' ? (
          <TerminalDragPreview label={activeDrag.terminal.label} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});

/**
 * One horizontal split pane: optional resize handle + resizable panel +
 * PaneProvider + PaneContent (which self-hosts PaneDimensionProvider on its
 * content region so the TabBar is excluded from the measured dimensions).
 */
const SplitPane = observer(function SplitPane({ group }: { group: PaneGroup }) {
  const taskView = useTaskComposition();
  const canSplit = group.pane.resolvedTabs.length >= 2 && taskView.paneLayout.canInsertPane;
  return (
    <div
      className="h-full min-h-0 min-w-0"
      onPointerDown={() => taskView.paneLayout.setActiveGroup(group.paneId)}
    >
      <PaneProvider
        group={group}
        canSplit={canSplit}
        splitPane={() => taskView.paneLayout.splitRight()}
        splitPaneDown={() => taskView.paneLayout.splitDown()}
      >
        <PaneContent emptyState={<PaneEmptyState />} trailingSlot={<NewConversationTabButton />} />
      </PaneProvider>
    </div>
  );
});

/**
 * Panes render once, keyed by paneId, into detached host elements; the layout
 * tree only places those hosts. Splitting or closing a neighbour therefore moves
 * the host's DOM instead of remounting Monaco, chat, or terminal content.
 */
const PaneHostContext = createContext<(paneId: string) => HTMLDivElement>(() => {
  throw new Error('PaneHostContext is missing');
});

/**
 * Scroll offsets inside a host as it leaves its slot. Taking a node out of the document
 * resets every scroll position in it, so a transcript or preview would jump to the top.
 */
const savedScroll = new WeakMap<HTMLElement, Array<[Element, number, number]>>();

function saveScroll(host: HTMLElement): void {
  const scrolled: Array<[Element, number, number]> = [];
  for (const element of host.querySelectorAll('*')) {
    if (element.scrollTop || element.scrollLeft) {
      scrolled.push([element, element.scrollTop, element.scrollLeft]);
    }
  }
  savedScroll.set(host, scrolled);
}

function restoreScroll(host: HTMLElement): void {
  const scrolled = savedScroll.get(host);
  savedScroll.delete(host);
  if (!scrolled?.length) return;
  const apply = () => {
    for (const [element, top, left] of scrolled) {
      if (!host.contains(element)) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  };
  apply();
  // Panel sizes can settle a frame later; until then a short slot clamps the offsets.
  requestAnimationFrame(apply);
}

function PaneSlot({ paneId }: { paneId: string }) {
  const hostFor = useContext(PaneHostContext);
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const host = hostFor(paneId);
    slot.appendChild(host);
    restoreScroll(host);
    return () => {
      // Runs while the old slot is still in the document, so offsets are still readable.
      if (host.parentElement === slot) {
        saveScroll(host);
        slot.removeChild(host);
      }
    };
  }, [hostFor, paneId]);
  return <div ref={slotRef} className="h-full min-h-0 min-w-0" />;
}

const SplitNodeView = observer(function SplitNodeView({
  node,
  storage,
}: {
  node: PaneLayoutNode;
  storage: MementoLayoutStorage;
}) {
  if (node.kind === 'pane') return <PaneSlot paneId={node.paneId} />;
  return <SplitGroupView node={node} storage={storage} />;
});

/**
 * One split, horizontal or vertical. The root horizontal row keeps the
 * `task-main-split` storage id so sizes saved before vertical splits still
 * apply. Nested splits use their own id.
 */
const SplitGroupView = observer(function SplitGroupView({
  node,
  storage,
}: {
  node: Extract<PaneLayoutNode, { kind: 'split' }>;
  storage: MementoLayoutStorage;
}) {
  const panelIds = node.children.map((child) =>
    child.kind === 'pane' ? splitPanePanelId(child.paneId) : `split-group-${child.id}`
  );
  const storageId =
    node.id === 'root' && node.orientation === 'horizontal'
      ? 'task-main-split'
      : `task-split-${node.id}`;
  const { defaultLayout, onLayoutChanged } = useResizableDefaultLayout({
    id: storageId,
    panelIds,
    storage,
  });
  const evenSharePct = Math.floor(100 / node.children.length);

  return (
    <div className="h-full min-h-0 min-w-0">
      <Resizable.Group
        orientation={node.orientation}
        id={storageId}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {node.children.map((child, index) => {
          const panelId = panelIds[index] ?? `split-group-${index}`;
          return (
            <Fragment key={panelId}>
              {index > 0 && <Resizable.Handle />}
              <Resizable.Panel
                id={panelId}
                defaultSize={`${defaultLayout?.[panelId] ?? evenSharePct}%`}
                minSize={node.orientation === 'vertical' ? '80px' : '200px'}
              >
                <SplitNodeView node={child} storage={storage} />
              </Resizable.Panel>
            </Fragment>
          );
        })}
      </Resizable.Group>
    </div>
  );
});

/** Renders the nested pane splits. A single pane fills the column. */
const SplitPaneLayout = observer(function SplitPaneLayout({
  storage,
}: {
  storage: MementoLayoutStorage;
}) {
  const taskView = useTaskComposition();
  const { root, groups } = taskView.paneLayout;
  const windowCommands = useMemo(() => taskTabWindowCommands(taskView), [taskView]);
  const [hosts] = useState(() => new Map<string, HTMLDivElement>());
  const hostFor = useCallback(
    (paneId: string) => {
      let host = hosts.get(paneId);
      if (!host) {
        host = document.createElement('div');
        host.className = 'h-full min-h-0 min-w-0';
        hosts.set(paneId, host);
      }
      return host;
    },
    [hosts]
  );

  useEffect(() => {
    const live = new Set(groups.map((group) => group.paneId));
    for (const paneId of hosts.keys()) {
      if (!live.has(paneId)) hosts.delete(paneId);
    }
  });

  usePruneRemovedSplitSizes(root, storage);

  return (
    <TabWindowCommandsContext.Provider value={windowCommands}>
      <PaneHostContext.Provider value={hostFor}>
        <SplitNodeView node={root} storage={storage} />
        {groups.map((group) => (
          <Fragment key={group.paneId}>
            {createPortal(<SplitPane group={group} />, hostFor(group.paneId))}
          </Fragment>
        ))}
      </PaneHostContext.Provider>
    </TabWindowCommandsContext.Provider>
  );
});

/**
 * Drops saved sizes that reference a split which just left the tree (collapsed
 * or flattened). Destroyed panes' own entries are dropped by the composition.
 * Only splits seen in a previous render are pruned, so a restore never loses sizes.
 */
function usePruneRemovedSplitSizes(root: PaneLayoutNode, storage: MementoLayoutStorage) {
  const taskView = useTaskComposition();
  const previousSplitIds = useRef<ReadonlySet<string>>(new Set(layoutSplitIds(root)));
  useEffect(() => {
    const current = new Set(layoutSplitIds(root));
    const removed = [...previousSplitIds.current].filter((id) => !current.has(id));
    previousSplitIds.current = current;
    if (removed.length === 0) return;
    const segments = new Set(removed.flatMap((id) => [`split-group-${id}`, `task-split-${id}`]));
    const keys = Object.keys(taskView.space.handle(taskPanelLayoutsMemento).value.layouts);
    for (const key of keys) {
      if (key.split(':').some((segment) => segments.has(segment))) storage.deleteEntry(key);
    }
  }, [root, storage, taskView.space]);
}

type PointerPoint = { clientX: number; clientY: number; screenX: number; screenY: number };

/** Where the pointer was last seen during a tab drag (the browser keeps reporting it outside the window). */
let lastPointer: PointerPoint | null = null;
const onPointerMove = (event: PointerEvent) => {
  lastPointer = {
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  };
};

function trackPointer(): void {
  lastPointer = null;
  window.addEventListener('pointermove', onPointerMove, true);
}

function stopTrackingPointer(): PointerPoint | null {
  window.removeEventListener('pointermove', onPointerMove, true);
  const point = lastPointer;
  lastPointer = null;
  return point;
}

function isOutsideWindow(point: PointerPoint): boolean {
  return (
    point.clientX < 0 ||
    point.clientY < 0 ||
    point.clientX > window.innerWidth ||
    point.clientY > window.innerHeight
  );
}

function TerminalDragPreview({ label }: { label: string }) {
  return (
    <div className="surface-paper flex cursor-grabbing items-center gap-1.5 rounded-md border border-border bg-(--em-surface) px-2 py-1 text-sm opacity-80 shadow-lg">
      <span className="max-w-[200px] truncate">{label}</span>
    </div>
  );
}
