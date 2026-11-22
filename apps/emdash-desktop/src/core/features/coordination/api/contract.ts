import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { delegationStatusSchema } from '@core/features/agent-control/api/delegations';
import {
  documentCommitSchema,
  documentWriteSchema,
  documentMigrationInputSchema,
  documentPushOptionsSchema,
  documentPushPlanSchema,
  documentPathSchema,
  documentRevisionSchema,
  documentWorkspaceSchema,
  managementDocumentSchema,
} from './documents';
import {
  livePromotionSchema,
  optimizationRiskSchema,
  optimizationRunSchema,
  optimizationRunStateSchema,
  optimizationSuggestionSchema,
} from './optimization';
import {
  agentSelectionSchema,
  projectAccessSchema,
  workspaceLifecycleSchema,
  workspaceWorkItemSchema,
  type Coordinator,
  type CoordinationEvent,
  type ResolvedAgentSelection,
  type TakeoverPreview,
} from './types';

export const coordinationDomain = 'coordination' as const;
export const coordinationContract = defineContract({
  cancelDocumentStorageSetup: procedure({
    input: z.object({ id: z.string(), taskId: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  prepareDocumentMigration: procedure({
    input: documentMigrationInputSchema.extend({ id: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  runDocumentMigration: procedure({
    input: z.object({ id: z.string(), migrationId: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  cancelDocumentMigration: procedure({
    input: z.object({ id: z.string(), migrationId: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  writeDocument: procedure({
    input: documentWriteSchema.extend({ id: z.string() }),
    output: managementDocumentSchema,
  }),
  createDocumentStorage: procedure({
    input: z.object({ id: z.string(), projectId: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  delegationStatus: procedure({
    input: z.object({ id: z.string(), taskId: z.string() }),
    output: delegationStatusSchema.nullable(),
  }),
  retryTask: procedure({
    input: z.object({ id: z.string(), taskId: z.string() }),
    output: z.void(),
  }),
  documentPushOptions: procedure({
    input: z.object({ id: z.string() }),
    output: documentPushOptionsSchema,
  }),
  configureDocumentPush: procedure({
    input: z.object({
      id: z.string(),
      remote: z.string().min(1).nullable(),
      expectedFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  prepareDocumentPush: procedure({
    input: z.object({
      id: z.string(),
      expectedRevision: documentCommitSchema.shape.expectedRevision,
      expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    output: documentPushPlanSchema,
  }),
  commitDocuments: procedure({
    input: documentCommitSchema.extend({ id: z.string() }),
    output: z.object({ hash: z.string() }),
  }),
  documentWorkspace: procedure({
    input: z.object({ id: z.string() }),
    output: documentWorkspaceSchema,
  }),
  createDocument: procedure({
    input: z.object({ id: z.string(), path: documentPathSchema }),
    output: documentWorkspaceSchema,
  }),
  readDocument: procedure({
    input: z.object({
      id: z.string(),
      path: documentPathSchema,
      revision: documentRevisionSchema.optional(),
    }),
    output: managementDocumentSchema,
  }),
  cancelPendingTask: procedure({
    input: z.object({ id: z.string(), taskId: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  inspectTask: procedure({
    input: z.object({ id: z.string(), taskId: z.string() }),
    output: z.custom<TakeoverPreview>(),
  }),
  takeOverTask: procedure({
    input: z.object({ id: z.string(), taskId: z.string(), expectedOwner: z.string().nullable() }),
    output: z.custom<Coordinator>(),
  }),
  createCrossProject: procedure({
    input: z.object({
      id: z.uuid(),
      name: z.string().trim().min(1).max(100),
      projectId: z.string().min(1).optional(),
      projectIds: z.array(z.string().min(1)),
      primary: agentSelectionSchema.optional(),
      delegationDefaults: agentSelectionSchema.optional(),
      purpose: z.string().max(20_000).optional(),
      lifecycle: workspaceLifecycleSchema.optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  migrateToStandalone: procedure({
    input: z.object({ id: z.string(), requestId: z.uuid() }),
    output: z.custom<Coordinator>(),
  }),
  rollbackStandaloneMigration: procedure({
    input: z.object({ id: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  prepareProjectImport: procedure({
    input: z.object({
      id: z.string(),
      requestId: z.uuid(),
      repositoryUrl: z.string().trim().min(1),
      name: z.string().trim().min(1).max(100),
      directory: z.string().trim().min(1).max(120),
    }),
    output: z.custom<Coordinator>(),
  }),
  updateProjectImport: procedure({
    input: z.object({
      id: z.string(),
      requestId: z.uuid(),
      state: z.enum(['cloning', 'registering', 'ready', 'failed', 'cancelled']),
      progress: z.number().min(0).max(100).optional(),
      projectId: z.string().optional(),
      error: z.string().optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  open: procedure({ input: z.object({ id: z.string() }), output: z.custom<Coordinator>() }),
  bindConversation: procedure({
    input: z.object({ id: z.string(), conversationId: z.string().min(1) }),
    output: z.custom<Coordinator>(),
  }),
  selectionOptions: procedure({
    input: z.object({ id: z.string(), selection: agentSelectionSchema }),
    output: z.custom<ResolvedAgentSelection>(),
  }),
  list: procedure({ input: z.void(), output: z.array(z.custom<Coordinator>()) }),
  getByTask: procedure({
    input: z.object({ taskId: z.string() }),
    output: z.custom<Coordinator | null>(),
  }),
  openProject: procedure({
    input: z.object({ projectId: z.string() }),
    output: z.custom<Coordinator>(),
  }),
  update: procedure({
    input: z.object({
      id: z.string(),
      primary: agentSelectionSchema.optional(),
      delegationDefaults: agentSelectionSchema.optional(),
      projectAccess: projectAccessSchema.optional(),
      projectIds: z.array(z.string().min(1)).optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  addWorkItem: procedure({
    input: z.object({
      id: z.string(),
      requestId: z.uuid(),
      title: z.string().trim().min(1).max(200),
      detail: z.string().max(20_000).optional(),
      kind: workspaceWorkItemSchema.shape.kind.optional(),
      origin: workspaceWorkItemSchema.shape.origin.optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  updateWorkItem: procedure({
    input: z.object({
      id: z.string(),
      workItemId: z.string(),
      title: z.string().trim().min(1).max(200).optional(),
      detail: z.string().max(20_000).optional(),
      state: workspaceWorkItemSchema.shape.state,
    }),
    output: z.custom<Coordinator>(),
  }),
  createOptimizationRun: procedure({
    input: z.object({
      id: z.string(),
      requestId: z.uuid(),
      conversationId: z.string().min(1),
      suggestionId: z.uuid().optional(),
      executionMode: optimizationRunSchema.shape.executionMode,
      experienceConfirmation: optimizationRunSchema.shape.experienceConfirmation,
      objective: optimizationRunSchema.shape.objective,
      observedProblem: optimizationRunSchema.shape.observedProblem,
      capturedContext: optimizationRunSchema.shape.capturedContext,
      baseline: optimizationRunSchema.shape.baseline,
      risk: optimizationRiskSchema,
    }),
    output: z.custom<Coordinator>(),
  }),
  transitionOptimizationRun: procedure({
    input: z.object({
      id: z.string(),
      runId: z.uuid(),
      state: optimizationRunStateSchema,
      reason: z.string().max(20_000).optional(),
      risk: optimizationRiskSchema.optional(),
      technicalValidationPassed: z.boolean().optional(),
      userDecision: z.enum(['pending', 'accepted', 'continue', 'rollback']).optional(),
      note: z.string().max(20_000).optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  addOptimizationSuggestion: procedure({
    input: z.object({
      id: z.string(),
      requestId: z.uuid(),
      fingerprint: optimizationSuggestionSchema.shape.fingerprint,
      title: optimizationSuggestionSchema.shape.title,
      observedPattern: optimizationSuggestionSchema.shape.observedPattern,
      proposedOutcome: optimizationSuggestionSchema.shape.proposedOutcome,
      evidenceRefs: optimizationSuggestionSchema.shape.evidenceRefs,
      confidence: optimizationSuggestionSchema.shape.confidence,
    }),
    output: z.custom<Coordinator>(),
  }),
  updateOptimizationSuggestion: procedure({
    input: z.object({
      id: z.string(),
      suggestionId: z.uuid(),
      state: z.enum(['dismissed', 'expired']),
    }),
    output: z.custom<Coordinator>(),
  }),
  recordLivePromotion: procedure({
    input: livePromotionSchema.omit({ createdAt: true, updatedAt: true }).extend({
      coordinatorId: z.string(),
    }),
    output: z.custom<Coordinator>(),
  }),
  checkpoint: procedure({
    input: z.object({
      id: z.string(),
      requestId: z.uuid(),
      title: z.string().trim().min(1).max(200),
    }),
    output: z.custom<Coordinator>(),
  }),
  setLifecycleState: procedure({
    input: z.object({
      id: z.string(),
      action: z.enum(['complete', 'pause', 'resume', 'archive', 'restore']),
      note: z.string().max(20_000).optional(),
    }),
    output: z.custom<Coordinator>(),
  }),
  review: procedure({
    input: z.object({
      id: z.string(),
      taskId: z.string(),
      accepted: z.boolean(),
      resultVersion: z.number().int().positive(),
      note: z.string().trim().min(1),
    }),
    output: z.custom<Coordinator>(),
  }),
  retryDelivery: procedure({ input: z.object({ id: z.string() }), output: z.void() }),
  events: eventStream({ key: z.void(), event: z.custom<CoordinationEvent>() }),
});
