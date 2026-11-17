import { z } from 'zod';

export const selectionSourceSchema = z.enum([
  'request',
  'main-default',
  'agent-default',
  'adapter-default',
  'caller',
]);
export const selectionValuesSchema = z.object({
  agent: z.string().min(1),
  transport: z.enum(['pty', 'acp']),
  modelSource: z.string().nullable(),
  model: z.string().nullable(),
  supplierId: z.string().nullable(),
  effort: z.string().nullable(),
});
export const delegationSelectionSnapshotSchema = z.object({
  version: z.literal('1'),
  values: selectionValuesSchema,
  sources: z.object({
    agent: selectionSourceSchema,
    transport: selectionSourceSchema,
    modelSource: selectionSourceSchema,
    model: selectionSourceSchema,
    supplierId: selectionSourceSchema,
    effort: selectionSourceSchema,
  }),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DelegationSelectionSnapshot = z.infer<typeof delegationSelectionSnapshotSchema>;
