import { z } from 'zod';

export const delegationStatusSchema = z.object({
  taskId: z.string(),
  phase: z.enum(['prepared', 'created', 'activated', 'starting', 'started']),
  conversationId: z.string().optional(),
  path: z.string().optional(),
  error: z.string().optional(),
  waitReason: z.string().optional(),
  canRetry: z.boolean(),
});
export type TaskDelegationStatus = z.infer<typeof delegationStatusSchema>;
