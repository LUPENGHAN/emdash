import { comparer, reaction } from 'mobx';
import type {
  PaneLayoutSnapshotDocument,
  PaneLayoutSnapshotMemento,
} from '@core/primitives/workbench-shell/browser/tabs/persistence';

/** The pop-out record this window shows, or null in the main window. */
export const popoutWindowId: string | null =
  typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('popout') || null;

export function isPopoutWindow(): boolean {
  return popoutWindowId !== null;
}

let override: { taskId: string; memento: PaneLayoutSnapshotMemento } | null = null;

/**
 * In a pop-out, the task's pane layout is the pop-out's own (kept by the main process),
 * never the task's memento: the main window keeps writing that one.
 */
export function setPopoutPaneLayout(taskId: string, memento: PaneLayoutSnapshotMemento): void {
  override = { taskId, memento };
}

export function popoutPaneLayoutFor(taskId: string): PaneLayoutSnapshotMemento | undefined {
  return override?.taskId === taskId ? override.memento : undefined;
}

/** A pane-layout memento over a document the caller loads and saves. */
export function createPopoutLayoutMemento(
  initial: PaneLayoutSnapshotDocument | null,
  save: (document: PaneLayoutSnapshotDocument) => void
): PaneLayoutSnapshotMemento {
  let current: PaneLayoutSnapshotDocument = initial ?? {
    version: '2',
    groups: [],
    activeGroupId: '',
  };
  return {
    ready: Promise.resolve(),
    hasStoredValue: initial !== null,
    read: () => current,
    autoPersist: (read) =>
      reaction(
        () => read(),
        (document) => {
          current = document;
          save(document);
        },
        { equals: comparer.structural }
      ),
  };
}
