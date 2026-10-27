import { z } from 'zod';

export const MEMORY_TITLE_MAX = 200;
export const MEMORY_DETAIL_MAX = 2000;
export const MEMORY_PER_LIST_MAX = 500;
/** How many newest rows include the body when an agent lists decisions. */
export const MEMORY_LIST_WITH_DETAIL = 40;

export const memorySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({
    kind: z.literal('agent'),
    providerId: z.string().min(1),
    conversationId: z.string().min(1),
    taskId: z.string().min(1),
  }),
]);

export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(MEMORY_TITLE_MAX),
  detail: z.string().min(1).max(MEMORY_DETAIL_MAX).optional(),
  source: memorySourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

/**
 * One list document. Version stays 1: a later optional field must still parse.
 * Project lists and the global list use the same shape, in different KV namespaces.
 */
export const projectMemorySchema = z.object({
  version: z.literal(1),
  items: z.array(memoryRecordSchema).max(MEMORY_PER_LIST_MAX),
});

export type ProjectMemory = z.infer<typeof projectMemorySchema>;

/** Project memory is one list per project. Global memory is the other list. */
export type MemoryScope = { kind: 'project'; projectId: string } | { kind: 'global' };

export type MemoryEvent = { scope: 'project'; projectId: string } | { scope: 'global' };

export type MemoryChanges = {
  title?: string;
  /** Empty string clears the body. Omit to leave it. */
  detail?: string;
};

export type MemoryOperations = {
  list(scope: MemoryScope): Promise<MemoryRecord[]>;
  get(scope: MemoryScope, id: string): Promise<MemoryRecord>;
  add(
    scope: MemoryScope,
    input: { title: string; detail?: string },
    source: MemorySource
  ): Promise<MemoryRecord>;
  update(scope: MemoryScope, id: string, changes: MemoryChanges): Promise<MemoryRecord>;
  remove(scope: MemoryScope, id: string): Promise<void>;
  /** Drops that project's list when the project itself is deleted. Global is left alone. */
  removeProject(projectId: string): Promise<void>;
};
