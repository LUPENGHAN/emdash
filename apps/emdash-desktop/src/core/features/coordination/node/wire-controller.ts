import { createController } from '@emdash/wire/rpc';
import { coordinationContract } from '../api/contract';
import type { CoordinatorService } from './coordinator-service';
import { coordinationEvents } from './event-host';

export function createCoordinationWireController(service: CoordinatorService) {
  return createController(coordinationContract, {
    events: coordinationEvents,
    cancelDocumentStorageSetup: ({ id, taskId }) => service.cancelDocumentStorageSetup(id, taskId),
    prepareDocumentMigration: ({ id, ...input }) => service.prepareDocumentMigration(id, input),
    runDocumentMigration: ({ id, migrationId }) => service.runDocumentMigration(id, migrationId),
    cancelDocumentMigration: ({ id, migrationId }) =>
      service.cancelDocumentMigration(id, migrationId),
    writeDocument: ({ id, ...input }) => service.writeDocument(id, input),
    createDocumentStorage: ({ id, projectId }) => service.createDocumentStorage(id, projectId),
    delegationStatus: ({ id, taskId }) => service.delegationStatus(id, taskId),
    retryTask: ({ id, taskId }) => service.retryTask(id, taskId),
    documentPushOptions: ({ id }) => service.documentPushOptions(id),
    configureDocumentPush: ({ id, remote, expectedFingerprint }) =>
      service.configureDocumentPush(id, remote, expectedFingerprint),
    prepareDocumentPush: ({ id, expectedRevision, expectedFingerprint }) =>
      service.prepareDocumentPush(id, expectedRevision, expectedFingerprint),
    commitDocuments: ({ id, ...input }) => service.commitDocuments(id, input),
    documentWorkspace: ({ id }) => service.documentWorkspace(id),
    createDocument: ({ id, path }) => service.createDocument(id, path),
    readDocument: ({ id, path, revision }) => service.readDocument(id, path, revision),
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
