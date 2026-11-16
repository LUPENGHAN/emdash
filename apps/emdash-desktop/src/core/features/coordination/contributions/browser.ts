import { CoordinatorTaskPanel } from '../browser/coordinator-task-panel';
import { CrossProjectMainAgents } from '../browser/cross-project-main-agents';
import { MainAgentSidebarItem } from '../browser/main-agent-sidebar-item';

export const coordinationBrowserContributions = {
  taskPanel: CoordinatorTaskPanel,
  sidebarItem: MainAgentSidebarItem,
  crossProjectSidebar: CrossProjectMainAgents,
} as const;
