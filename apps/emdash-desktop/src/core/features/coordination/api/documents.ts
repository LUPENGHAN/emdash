import { hostFileRefSchema } from '@emdash/core/primitives/path/api';
import { pushTargetSchema, pushBranchJobInputSchema } from '@emdash/core/runtimes/git/api';
import { z } from 'zod';

export const documentPathSchema = z
  .string()
  .min(1)
  .max(1000)
  .superRefine((path, ctx) => {
    const segments = path.split('/');
    if (
      path.includes('\\') ||
      path.includes(':') ||
      /[\u0000-\u001f]/.test(path) ||
      segments.some(
        (part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Use a document path inside the workspace document checkout, without .git or parent traversal.',
      });
  });
export const documentRevisionSchema = z
  .string()
  .max(300)
  .refine(
    (value) => /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|disk:.+)$/.test(value),
    'Choose a full commit ID or a returned disk version.'
  );
export const documentWorkspaceSchema = z.object({
  workspaceId: z.string(),
  root: hostFileRefSchema,
  branch: z.string(),
  revision: z.string(),
});
export type DocumentWorkspace = z.infer<typeof documentWorkspaceSchema>;
export const managementDocumentSchema = z.object({
  coordinatorId: z.string(),
  path: documentPathSchema,
  revision: z.string(),
  content: z.string(),
  workspaceId: z.string(),
});
export type ManagementDocument = z.infer<typeof managementDocumentSchema>;

export const documentReferenceSchema = z.object({
  coordinatorId: z.string().min(1).optional(),
  path: documentPathSchema,
  revision: documentRevisionSchema.optional(),
});
export type ManagementDocumentReference = z.infer<typeof documentReferenceSchema>;
export const documentReferencesSchema = z.array(documentReferenceSchema).max(16);

export const documentCommitSchema = z.object({
  paths: z.array(documentPathSchema).min(1).max(100),
  message: z.string().trim().min(1).max(2000),
  expectedRevision: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
});
export type DocumentCommit = z.infer<typeof documentCommitSchema>;
export const documentWriteSchema = z.object({
  path: documentPathSchema,
  content: z.string().max(512 * 1024),
  expectedRevision: z.string().startsWith('disk:').max(300).optional(),
});
export type DocumentWrite = z.infer<typeof documentWriteSchema>;
export const documentMigrationInputSchema = z.object({
  requestId: z.uuid(),
  projectId: z.string().min(1),
  paths: z.array(documentPathSchema).min(1).max(100),
});
export type DocumentMigrationInput = z.infer<typeof documentMigrationInputSchema>;

export const documentPushOptionsSchema = z.object({
  targets: z.array(pushTargetSchema),
  unavailable: z.array(z.object({ remote: z.string(), message: z.string() })),
});
export const documentPushPlanSchema = pushBranchJobInputSchema
  .omit({ checkout: true, credentials: true })
  .extend({ workspaceId: z.string() });
