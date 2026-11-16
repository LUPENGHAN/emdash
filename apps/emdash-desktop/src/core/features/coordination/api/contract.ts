import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
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
