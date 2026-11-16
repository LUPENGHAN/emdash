import { hostFileRefSchema } from '@emdash/core/primitives/path/api';
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
          'Use a document path inside the management workspace, without .git or parent traversal.',
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
