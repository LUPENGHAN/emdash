import { z } from 'zod';
import { projectBaselineSelectionSchema } from '@core/features/projects/api/baseline-sync';
import { delegationSelectionSnapshotSchema } from './selection-snapshot';

export const delegationStatusSchema = z.object({
  taskId: z.string(),
  phase: z.enum(['prepared', 'created', 'activated', 'starting', 'started']),
  conversationId: z.string().optional(),
  path: z.string().optional(),
  error: z.string().optional(),
  waitReason: z.string().optional(),
  canRetry: z.boolean(),
  baselineSelection: projectBaselineSelectionSchema.optional(),
  selectionSnapshot: delegationSelectionSnapshotSchema.optional(),
});
export type TaskDelegationStatus = z.infer<typeof delegationStatusSchema>;
