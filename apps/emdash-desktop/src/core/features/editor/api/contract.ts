import { resourceUriSchema } from '@emdash/core/primitives/path/api';
import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { editorLspContract } from './lsp-contract';

const editorBufferKeySchema = z.object({ uri: resourceUriSchema });

export const editorDomain = 'editor' as const;

// The editor owns crash recovery and language services. File content and disk
// mutations remain in the files domain.
export const editorContract = defineContract({
  lsp: editorLspContract,
  saveBuffer: procedure({
    // `baseHash` is the disk text the draft was edited from, so recovery can
    // tell a stale row (disk moved on) from one that still applies cleanly.
    input: editorBufferKeySchema.extend({ content: z.string(), baseHash: z.string().nullable() }),
    output: z.void(),
  }),
  clearBuffer: procedure({
    input: editorBufferKeySchema,
    output: z.void(),
  }),
  // Bulk cleanup for a whole root (after discarding all of its changes).
  clearBuffers: procedure({
    input: z.object({ root: resourceUriSchema }),
    output: z.void(),
  }),
  // Recovery enumeration: `root` scopes to buffers under that root ResourceUri
  // prefix; omitting it lists every buffer, including files outside any root.
  listBuffers: procedure({
    input: z.object({ root: resourceUriSchema.optional() }),
    output: z.array(
      z.object({
        uri: resourceUriSchema,
        content: z.string(),
        baseHash: z.string().nullable(),
        updatedAt: z.number(),
      })
    ),
  }),
});

export type EditorContract = typeof editorContract;
