import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { MemoryEvent, MemoryRecord } from './types';

export const memoryDomain = 'memory' as const;

const scopeInput = {
  scope: z.enum(['project', 'global']),
  projectId: z.string().optional(),
};

export const memoryContract = defineContract({
  list: procedure({
    input: z.object(scopeInput),
    output: z.custom<MemoryRecord[]>(),
  }),
  get: procedure({
    input: z.object({ ...scopeInput, id: z.string() }),
    output: z.custom<MemoryRecord>(),
  }),
  add: procedure({
    input: z.object({
      ...scopeInput,
      title: z.string(),
      detail: z.string().optional(),
    }),
    output: z.custom<MemoryRecord>(),
  }),
  update: procedure({
    input: z.object({
      ...scopeInput,
      id: z.string(),
      title: z.string().optional(),
      detail: z.string().optional(),
    }),
    output: z.custom<MemoryRecord>(),
  }),
  remove: procedure({
    input: z.object({ ...scopeInput, id: z.string() }),
    output: z.void(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<MemoryEvent>() }),
});
