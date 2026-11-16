import { hostRefSchema } from '@emdash/core/primitives/host/api';
import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import { z } from 'zod';

export const baselineOidSchema = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
export const baselineVerificationConfigSchema = z.object({
  command: z.string().refine((command) => command.trim().length > 0, {
    message: 'The baseline verification command must not be empty.',
  }),
  timeoutMs: z.number().int().positive().optional(),
});
export const projectBaselineConfigSchema = z.object({
  verification: baselineVerificationConfigSchema.nullable().default(null),
});
export type ProjectBaselineConfig = z.infer<typeof projectBaselineConfigSchema>;

export const projectBaselineTargetSchema = z
  .object({
    projectId: z.string().min(1),
    repositoryKey: z.string().min(1),
    workspaceId: z.string().min(1),
    host: hostRefSchema,
    checkout: z.string().min(1),
    baselineRef: localBranchRefSchema,
    remote: z.string().min(1).nullable(),
    upstreamRef: localBranchRefSchema.nullable(),
  })
  .refine((value) => (value.remote === null) === (value.upstreamRef === null), {
    message: 'A baseline upstream requires both a remote and a ref.',
  });
export type ProjectBaselineTarget = z.infer<typeof projectBaselineTargetSchema>;

export const projectBaselineSelectionSchema = z.object({
  oid: baselineOidSchema,
  target: projectBaselineTargetSchema,
  checkedAt: z.number().nullable(),
  offline: z.boolean(),
  revision: z.number().int().nonnegative(),
  remoteFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  verification: z.enum(['not-configured', 'succeeded']),
  verifiedAt: z.number().nullable(),
});
export type ProjectBaselineSelection = z.infer<typeof projectBaselineSelectionSchema>;

export const projectBaselineObservationSchema = z.object({
  kind: z.enum(['updated', 'current', 'local', 'blocked', 'unavailable']),
  beforeOid: baselineOidSchema.nullable(),
  oid: baselineOidSchema.nullable(),
  upstreamOid: baselineOidSchema.nullable(),
  remoteFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  reason: z.string().optional(),
  message: z.string().optional(),
});
export type ProjectBaselineObservation = z.infer<typeof projectBaselineObservationSchema>;

export const baselineVerificationSchema = z
  .object({
    status: z.enum(['starting', 'running', 'succeeded', 'failed', 'unknown']),
    workspaceId: z.string().optional(),
    workspacePath: z.string().optional(),
    runId: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    output: z.string().default(''),
    message: z.string().optional(),
  })
  .refine(
    (value) => value.status !== 'succeeded' || value.exitCode === undefined || value.exitCode === 0,
    {
      message: 'Successful baseline verification requires a zero exit status.',
    }
  );
export type BaselineVerification = z.infer<typeof baselineVerificationSchema>;

export const projectBaselineTriggerSchema = z.enum([
  'manual',
  'attach',
  'recover',
  'delegation',
  'pr-merged',
]);
export type ProjectBaselineTrigger = z.infer<typeof projectBaselineTriggerSchema>;
export const baselineCleanupSchema = z.object({
  status: z.enum(['pending', 'removed', 'blocked']),
  requestedAt: z.number(),
  finishedAt: z.number().optional(),
  message: z.string().optional(),
});
export type BaselineCleanup = z.infer<typeof baselineCleanupSchema>;
export const projectBaselineAttemptSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  trigger: projectBaselineTriggerSchema,
  target: projectBaselineTargetSchema,
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  phase: z.enum(['fetching', 'verifying', 'ready', 'offline', 'blocked', 'failed']),
  observation: projectBaselineObservationSchema.optional(),
  verificationConfig: baselineVerificationConfigSchema.nullable(),
  verification: baselineVerificationSchema.optional(),
  cleanup: baselineCleanupSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ProjectBaselineAttempt = z.infer<typeof projectBaselineAttemptSchema>;

const proofSchema = z.object({
  revision: z.number().int().nonnegative(),
  targetKey: z.string(),
  oid: baselineOidSchema,
  remoteFingerprint: z.string().nullable(),
  checkedAt: z.number(),
  verification: z.enum(['not-configured', 'succeeded']),
});
const baselineStateSchema = z.object({
  version: z.literal('1'),
  revision: z.number().int().nonnegative(),
  config: projectBaselineConfigSchema,
  attempts: z.array(projectBaselineAttemptSchema),
  lastContactAt: z.number().nullable(),
  resolutionError: z
    .object({ revision: z.number().int().nonnegative(), at: z.number(), message: z.string() })
    .optional(),
  proof: proofSchema.optional(),
  denied: proofSchema
    .omit({ checkedAt: true, verification: true })
    .extend({
      reason: z.string(),
    })
    .optional(),
});
export const projectBaselineRecord = defineVersionedSchema()
  .initial('1', baselineStateSchema)
  .build();
export type ProjectBaselineRecord = typeof projectBaselineRecord.Type;

export const projectBaselineSnapshotSchema = baselineStateSchema.extend({
  status: z.enum([
    'not-checked',
    'needs-check',
    'interrupted',
    'fetching',
    'verifying',
    'ready',
    'offline',
    'blocked',
    'failed',
  ]),
  canDelegate: z.boolean(),
});
export type ProjectBaselineSnapshot = z.infer<typeof projectBaselineSnapshotSchema>;
