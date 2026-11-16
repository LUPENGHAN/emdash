import { createController } from '@emdash/wire/rpc';
import { coordinationContract } from '../api/contract';
import type { CoordinatorService } from './coordinator-service';
import { coordinationEvents } from './event-host';

export function createCoordinationWireController(service: CoordinatorService) {
  return createController(coordinationContract, {
    events: coordinationEvents,
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
