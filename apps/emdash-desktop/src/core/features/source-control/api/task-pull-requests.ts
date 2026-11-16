import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { localBranchRefSchema, pushTargetSchema } from '@emdash/core/runtimes/git/api';
import { z } from 'zod';

export const taskPullRequestInputSchema = z.object({
  taskId: z.string().min(1),
  requestId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(1000),
  body: z.string().max(100_000).optional(),
  draft: z.boolean(),
  sourceBranch: z.string().min(1).optional(),
  pushRemote: z.string().min(1).optional(),
  repositoryUrl: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
});
export type TaskPullRequestInput = z.infer<typeof taskPullRequestInputSchema>;

export const taskPullRequestPlanSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  sourceRef: localBranchRefSchema,
  oid: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
  pushTarget: pushTargetSchema,
  repositoryUrl: z.string(),
  headRepositoryUrl: z.string(),
  base: z.string().min(1),
  title: z.string(),
  body: z.string().optional(),
  draft: z.boolean(),
});
export type TaskPullRequestPlan = z.infer<typeof taskPullRequestPlanSchema>;

export const taskPullRequestRecord = defineVersionedSchema()
  .initial(
    '1',
    z.object({
      version: z.literal('1'),
      requestId: z.string(),
      fingerprint: z.string(),
      plan: taskPullRequestPlanSchema,
      phase: z.enum(['prepared', 'pushing', 'pushed', 'creating', 'complete']),
      result: z.object({ url: z.string(), number: z.number().int().positive() }).optional(),
      error: z.string().optional(),
    })
  )
  .build();
export type TaskPullRequestRecord = typeof taskPullRequestRecord.Type;
