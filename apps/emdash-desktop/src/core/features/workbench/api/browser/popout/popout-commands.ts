import { AppWindow, PanelLeftClose } from 'lucide-react';
import { popoutWindowId } from '@core/features/workbench/api/browser/popout-mode';
import type { TaskComposition } from '@core/features/workbench/api/browser/task-composition';
import type { TabWindowCommands } from '@core/primitives/workbench-shell/browser/tabs/tab-bar/tab-context-menu';
import { popOutTabs, returnTabsToMain } from './popout-actions';

/** Pop-out windows exist only in the desktop app, not in a browser using it remotely. */
const canOpenWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

/** The tab menu's window commands for a task's panes, in the main window or a pop-out. */
export function taskTabWindowCommands(composition: TaskComposition): TabWindowCommands | null {
  if (!canOpenWindows) return null;
  const popoutId = popoutWindowId;
  if (popoutId) {
    return (tab, paneId) => [
      {
        id: 'window:return-tab',
        label: 'Move to Main Window',
        icon: PanelLeftClose,
        run: () => returnTabsToMain(popoutId, composition, paneId, [tab.tabId]),
      },
    ];
  }
  return (tab, paneId) => {
    const pane = composition.paneLayout.groups.find((group) => group.paneId === paneId)?.pane;
    return [
      {
        id: 'window:popout-tab',
        label: 'Open in New Window',
        icon: AppWindow,
        run: () => popOutTabs(composition, paneId, [tab.tabId]),
      },
      {
        id: 'window:popout-pane',
        label: 'Move Pane to New Window',
        icon: AppWindow,
        isAvailable: () => (pane?.tabOrder.length ?? 0) > 1,
        run: () => popOutTabs(composition, paneId),
      },
    ];
  };
}
