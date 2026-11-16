import { z } from 'zod';
import { localBranchRefSchema } from '#runtimes/git/api/repository/states/refs';
import { gitOperationCredentialsSchema } from '#runtimes/git/api/schemas';
import { checkoutSelectorSchema } from '#runtimes/git/api/selectors';

const oidSchema = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
export const syncBaselineJobInputSchema = checkoutSelectorSchema.extend({
  remote: z.string().min(1),
  upstreamRef: localBranchRefSchema,
  baselineRef: localBranchRefSchema,
  expectedRemoteFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  credentials: gitOperationCredentialsSchema.optional(),
});
export type SyncBaselineJobInput = z.infer<typeof syncBaselineJobInputSchema>;

const baselineSyncObservationSchema = z.object({
  remote: z.string(),
  remoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  upstreamRef: localBranchRefSchema,
  baselineRef: localBranchRefSchema,
  beforeOid: oidSchema.nullable(),
  upstreamOid: oidSchema.nullable(),
  afterOid: oidSchema.nullable(),
  previousUpstreamOid: oidSchema.nullable(),
});

export const baselineSyncResultSchema = z.discriminatedUnion('kind', [
  baselineSyncObservationSchema.extend({
    kind: z.enum(['updated', 'current']),
    upstreamOid: oidSchema,
    afterOid: oidSchema,
  }),
  baselineSyncObservationSchema.extend({
    kind: z.literal('blocked'),
    reason: z.enum([
      'management-branch',
      'remote-changed',
      'symbolic-baseline',
      'symbolic-checkpoint',
      'upstream-rewritten',
      'history-unavailable',
      'checked-out-elsewhere',
      'checkout-unavailable',
      'checkout-busy',
      'checkout-dirty',
      'local-ahead',
      'diverged',
      'local-changed',
    ]),
  }),
]);
export type BaselineSyncResult = z.infer<typeof baselineSyncResultSchema>;
