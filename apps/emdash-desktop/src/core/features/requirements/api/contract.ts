import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { Requirement, RequirementsEvent } from './types';

export const requirementsDomain = 'requirements' as const;

export const requirementsContract = defineContract({
  list: procedure({
    input: z.object({ projectId: z.string() }),
    output: z.custom<Requirement[]>(),
  }),
  add: procedure({
    input: z.object({
      projectId: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      parentId: z.string().optional(),
    }),
    output: z.custom<Requirement>(),
  }),
  update: procedure({
    input: z.object({
      projectId: z.string(),
      id: z.string(),
      title: z.string().optional(),
      detail: z.string().optional(),
      status: z.enum(['open', 'done']).optional(),
      parentId: z.string().optional(),
    }),
    output: z.custom<Requirement>(),
  }),
  remove: procedure({
    input: z.object({ projectId: z.string(), id: z.string() }),
    output: z.void(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<RequirementsEvent>() }),
});
