import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  agentSelectionSchema,
  type Coordinator,
  type CoordinationEvent,
  type ResolvedAgentSelection,
} from './types';

export const coordinationDomain = 'coordination' as const;
export const coordinationContract = defineContract({
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
