import { CoordinatorTaskPanel } from '../browser/coordinator-task-panel';
import { MainAgentSidebarItem } from '../browser/main-agent-sidebar-item';

export const coordinationBrowserContributions = {
  taskPanel: CoordinatorTaskPanel,
  sidebarItem: MainAgentSidebarItem,
} as const;
