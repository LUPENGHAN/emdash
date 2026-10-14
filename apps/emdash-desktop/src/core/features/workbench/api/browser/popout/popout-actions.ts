import { toast } from '@emdash/ui/react/primitives';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import {
  taskPaneLayoutMemento,
  taskPaneLayoutSnapshotSchema,
  type TabManagerSnapshot,
} from '@core/features/tasks/contributions/mementos';
import { taskSubject } from '@core/features/tasks/contributions/subject';
import type { TaskComposition } from '@core/features/workbench/api/browser/task-composition';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { PopoutReturn } from '@core/primitives/desktop-host/api/host-contract';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { log } from '@core/primitives/logging/browser/logger';
import { getMementoClient } from '@core/primitives/mementos/browser';

/**
 * Moves tabs of a pane (all of them when `tabIds` is omitted) into a window of their
 * own. Unsaved edits live in this window only, so a tab with any stays here.
 */
export async function popOutTabs(
  composition: TaskComposition,
  paneId: string,
  tabIds?: readonly string[],
  position?: { x: number; y: number }
): Promise<void> {
  const pane = composition.paneLayout.groups.find((group) => group.paneId === paneId)?.pane;
  if (!pane) return;
  const ids = tabIds ?? [...pane.tabOrder];
  const unsaved = ids.some(
    (id) => (pane._resources.get(id) as { isDirty?: boolean } | undefined)?.isDirty === true
  );
  if (unsaved) {
    toast.error('Save the file first', {
      description: 'Unsaved changes stay in this window, so the tab cannot move yet.',
    });
    return;
  }
  const tabs = composition.paneLayout.takeTabsForTransfer(paneId, ids);
  if (!tabs) return;
  const groupId = crypto.randomUUID();
  const layout = {
    version: '2',
    groups: [{ groupId, tabManager: tabs }],
    activeGroupId: groupId,
    layout: { kind: 'pane', paneId: groupId },
  };
  try {
    await (
      await getHostClient()
    ).openPopoutWindow({
      projectId: composition.projectId,
      taskId: composition.taskId,
      title: getTaskStore(composition.projectId, composition.taskId)?.displayName ?? 'Emdash',
      originPaneId: paneId,
      layout,
      ...(position && { position }),
    });
  } catch (error) {
    // The tabs were taken out already: put them back rather than lose them.
    composition.paneLayout.receiveTabs([tabs], paneId);
    toast.error('Could not open a new window', { description: String(error) });
  }
}

/** The tab groups of a returned pop-out layout; nothing for a malformed one. */
function returnedGroups(layout: unknown): TabManagerSnapshot[] {
  const parsed = taskPaneLayoutSnapshotSchema.safeParse(layout);
  return parsed.success ? parsed.data.groups.map((group) => group.tabManager) : [];
}

/**
 * Puts a closed pop-out's tabs back into the main window: into the task's live layout
 * when its view exists, otherwise into the task's stored layout for its next open.
 */
export async function applyPopoutReturn(item: PopoutReturn): Promise<void> {
  const groups = returnedGroups(item.layout);
  if (groups.length === 0) return;
  const composition = getTaskComposition(item.projectId, item.taskId);
  if (composition) {
    composition.paneLayout.receiveTabs(groups, item.originPaneId);
    return;
  }
  const handle = getMementoClient()
    .subject(taskSubject({ taskId: item.taskId }))
    .handle(taskPaneLayoutMemento);
  try {
    await handle.ready;
    handle.update((current) => {
      const target =
        current.groups.find((group) => group.groupId === item.originPaneId) ?? current.groups[0];
      if (!target) return current;
      const open = new Set(target.tabManager.tabs.map((tab) => tab.tabId));
      const added = groups.flatMap((group) => group.tabs).filter((tab) => !open.has(tab.tabId));
      return {
        ...current,
        activeGroupId: target.groupId,
        groups: current.groups.map((group) =>
          group === target
            ? {
                ...group,
                tabManager: {
                  tabs: [...group.tabManager.tabs, ...added],
                  activeTabId: groups[0]?.activeTabId ?? group.tabManager.activeTabId,
                },
              }
            : group
        ),
      };
    });
    await handle.flush();
  } catch (error) {
    log.warn('popout: could not store returned tabs', { error });
  } finally {
    void handle.dispose();
  }
}

/** Takes the returned pop-outs the main process holds and puts their tabs back. */
export async function takePopoutReturns(): Promise<void> {
  const returns = await (await getHostClient()).takePopoutReturns();
  for (const item of returns) await applyPopoutReturn(item);
}

/** In a pop-out: sends tabs of a pane back to the main window. */
export async function returnTabsToMain(
  popoutId: string,
  composition: TaskComposition,
  paneId: string,
  tabIds: readonly string[]
): Promise<void> {
  const tabs = composition.paneLayout.takeTabsForTransfer(paneId, tabIds);
  if (!tabs) return;
  const groupId = crypto.randomUUID();
  const client = await getHostClient();
  await client.returnPopoutTabs({
    id: popoutId,
    layout: { version: '2', groups: [{ groupId, tabManager: tabs }], activeGroupId: groupId },
  });
  // A pop-out left with nothing to show closes.
  const left = composition.paneLayout.groups.some((group) => group.pane.tabOrder.length > 0);
  if (!left) await client.returnPopoutWindow({ id: popoutId });
}
