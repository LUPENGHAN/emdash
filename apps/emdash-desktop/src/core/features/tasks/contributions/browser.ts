import { addRemoteModal } from '../browser/add-remote-modal';
import { taskModal } from '../browser/create-task-modal/create-task-modal';
import { deleteTaskModal } from '../browser/delete-task-modal';
import { EmbeddedTaskWorkspace } from '../browser/embedded-task-workspace';
import { renameTaskModal } from '../browser/rename-task-modal';
import { taskViewRuntime } from '../browser/view';

export const tasksBrowserContributions = {
  embeddedWorkspace: EmbeddedTaskWorkspace,
  views: [taskViewRuntime],
  modalDefs: [taskModal, renameTaskModal, addRemoteModal, deleteTaskModal],
} as const;
