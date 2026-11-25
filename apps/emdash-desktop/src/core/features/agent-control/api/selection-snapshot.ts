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
const delegationSelectionSnapshotV1Schema = z.object({
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
const delegationSelectionSnapshotV2Schema = z.object({
  version: z.literal('2'),
  values: selectionValuesSchema.extend({
    permissionMode: z.enum(['ask', 'full']),
  }),
  sources: z.object({
    agent: selectionSourceSchema,
    transport: selectionSourceSchema,
    modelSource: selectionSourceSchema,
    model: selectionSourceSchema,
    supplierId: selectionSourceSchema,
    effort: selectionSourceSchema,
    permissionMode: selectionSourceSchema,
  }),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const delegationSelectionSnapshotSchema = z.discriminatedUnion('version', [
  delegationSelectionSnapshotV1Schema,
  delegationSelectionSnapshotV2Schema,
]);
export type DelegationSelectionSnapshot = z.infer<typeof delegationSelectionSnapshotSchema>;
