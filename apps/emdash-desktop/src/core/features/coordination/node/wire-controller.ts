import { createController } from '@emdash/wire/rpc';
import { coordinationContract } from '../api/contract';
import type { CoordinatorService } from './coordinator-service';
import { coordinationEvents } from './event-host';

export function createCoordinationWireController(service: CoordinatorService) {
  return createController(coordinationContract, {
    events: coordinationEvents,
    cancelPendingTask: ({ id, taskId }) => service.cancelPendingTask(id, taskId),
    inspectTask: ({ id, taskId }) => service.inspectTask(id, taskId),
    takeOverTask: ({ id, taskId, expectedOwner }) =>
      service.takeOverTask(id, taskId, expectedOwner),
    createCrossProject: (input) => service.createCrossProject(input),
    open: ({ id }) => service.open(id),
    bindConversation: ({ id, conversationId }) => service.bindConversation(id, conversationId),
    selectionOptions: ({ id, selection }) => service.selectionOptions(id, selection),
    list: () => service.list(),
    getByTask: ({ taskId }) => service.getByTask(taskId),
    openProject: ({ projectId }) => service.openProject(projectId),
    update: ({ id, ...patch }) => service.update(id, patch),
    review: ({ id, taskId, accepted, note, resultVersion }) =>
      service.review(id, taskId, accepted, note, resultVersion),
    retryDelivery: ({ id }) => service.deliverPending(id),
  });
}
