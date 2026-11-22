import { CoordinatorTaskPanel } from '../browser/coordinator-task-panel';
import { createMainAgentModal, CrossProjectMainAgents } from '../browser/cross-project-main-agents';
import { deleteMainAgentModal } from '../browser/delete-main-agent-modal';
import { MainAgentSidebarItem } from '../browser/main-agent-sidebar-item';

export const coordinationBrowserContributions = {
  taskPanel: CoordinatorTaskPanel,
  sidebarItem: MainAgentSidebarItem,
  crossProjectSidebar: CrossProjectMainAgents,
  modalDefs: [createMainAgentModal, deleteMainAgentModal],
} as const;
