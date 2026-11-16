import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { delegationStatusSchema } from '@core/features/agent-control/api/delegations';
import {
  documentCommitSchema,
  documentWriteSchema,
  documentPushOptionsSchema,
  documentPushPlanSchema,
  documentPathSchema,
  documentRevisionSchema,
  documentWorkspaceSchema,
  managementDocumentSchema,
} from './documents';
import {
  agentSelectionSchema,
  projectAccessSchema,
  type Coordinator,
  type CoordinationEvent,
  type ResolvedAgentSelection,
  type TakeoverPreview,
} from './types';

export const coordinationDomain = 'coordination' as const;
export const coordinationContract = defineContract({
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
      projectId: z.string().min(1),
      projectIds: z.array(z.string().min(1)),
      primary: agentSelectionSchema.optional(),
      delegationDefaults: agentSelectionSchema.optional(),
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
