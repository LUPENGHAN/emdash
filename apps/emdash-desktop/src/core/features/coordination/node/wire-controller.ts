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
    migrateToStandalone: ({ id, requestId }) => service.migrateToStandalone(id, requestId),
    rollbackStandaloneMigration: ({ id }) => service.rollbackStandaloneMigration(id),
    prepareProjectImport: ({ id, ...input }) => service.prepareProjectImport(id, input),
    updateProjectImport: ({ id, requestId, ...patch }) =>
      service.updateProjectImport(id, requestId, patch),
    open: ({ id }) => service.open(id),
    bindConversation: ({ id, conversationId, autoResume }) =>
      service.bindConversation(id, conversationId, autoResume),
    updateResultRoutingPolicy: ({ id, policy }) => service.updateResultRoutingPolicy(id, policy),
    selectionOptions: ({ id, selection }) => service.selectionOptions(id, selection),
    list: (options) => service.list(options),
    getByTask: ({ taskId }) => service.getByTask(taskId),
    openProject: ({ projectId }) => service.openProject(projectId),
    update: ({ id, ...patch }) => service.update(id, patch),
    addWorkItem: ({ id, requestId, title, detail, kind, origin }) =>
      service.addWorkItem(id, {
        requestId,
        title,
        ...(detail !== undefined && { detail }),
        ...(kind !== undefined && { kind }),
        ...(origin !== undefined && { origin }),
      }),
    updateWorkItem: ({ id, workItemId, state, title, detail }) =>
      service.updateWorkItem(id, workItemId, {
        state,
        ...(title !== undefined && { title }),
        ...(detail !== undefined && { detail }),
      }),
    createOptimizationRun: ({ id, ...input }) => service.createOptimizationRun(id, input),
    transitionOptimizationRun: ({ id, runId, ...input }) =>
      service.transitionOptimizationRun(id, runId, input),
    addOptimizationSuggestion: ({ id, ...input }) => service.addOptimizationSuggestion(id, input),
    updateOptimizationSuggestion: ({ id, suggestionId, state }) =>
      service.updateOptimizationSuggestion(id, suggestionId, state),
    recordLivePromotion: ({ coordinatorId, ...input }) =>
      service.recordLivePromotion(coordinatorId, input),
    checkpoint: ({ id, requestId, title }) => service.checkpoint(id, requestId, title),
    setLifecycleState: ({ id, action, note }) => service.setLifecycleState(id, action, note),
    completeAndArchive: ({ id, note }) => service.completeAndArchive(id, note),
    trash: ({ id }) => service.trash(id),
    restoreTrash: ({ id }) => service.restoreTrash(id),
    permanentDeletePreview: ({ id }) => service.permanentDeletePreview(id),
    permanentlyDelete: ({ id, options }) => service.permanentlyDelete(id, options),
    review: ({ id, taskId, accepted, note, resultVersion }) =>
      service.review(id, taskId, accepted, note, resultVersion),
    retryDelivery: ({ id }) => service.deliverPending(id),
  });
}
