import type { HostFileRef } from '@emdash/core/primitives/path/api';
import { Button, Dialog } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { encodeFacetUri } from '@core/features/editor/api/browser/facet-binder/facet-uri';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import {
  StickyDiffEditor,
  type DiffSideModel,
} from '@core/features/editor/contributions/browser/monaco/sticky-diff-editor';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';

const DISK = { kind: 'disk' } as const;
const BUFFER = { kind: 'buffer' } as const;

export type RecoveredBufferDiffArgs = {
  /** The file's identity; its tab holds the leases that keep both facets warm. */
  ref: HostFileRef;
  path: string;
};

/**
 * Compares a recovered unsaved draft against the current disk text —
 * deliberately not a git diff, so the sides say which is which.
 */
export const RecoveredBufferDiffDialog = observer(function RecoveredBufferDiffDialog({
  ref,
  path,
}: RecoveredBufferDiffArgs) {
  const { complete } = useModalController('recoveredBufferDiff');
  const entry = openFileStore.peek(ref);
  const original: DiffSideModel | null =
    entry === undefined
      ? null
      : { kind: 'facet', entry, facet: DISK, uri: encodeFacetUri(ref, DISK) };
  const modified: DiffSideModel | null =
    entry === undefined
      ? null
      : { kind: 'facet', entry, facet: BUFFER, uri: encodeFacetUri(ref, BUFFER) };
  const shortPath = path.split('/').slice(-2).join('/');

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Unsaved Changes from an Earlier Session</Dialog.Title>
        <Dialog.Description>
          <code className="bg-muted rounded px-1 py-0.5 text-xs">{shortPath}</code> — the draft on
          the right was recovered after the file changed on disk.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Body height={520} className="flex flex-col gap-1 p-0">
        <div className="grid shrink-0 grid-cols-2 border-b border-border px-3 py-1 text-xs text-foreground-passive">
          <span>On disk</span>
          <span className="text-right">Unsaved changes</span>
        </div>
        <div className="min-h-0 flex-1">
          <StickyDiffEditor
            original={original}
            modified={modified}
            filePath={path}
            diffStyle="split"
          />
        </div>
      </Dialog.Body>
      <Dialog.Footer className="gap-2">
        <Button variant="secondary" onClick={() => complete(false)}>
          Close
        </Button>
      </Dialog.Footer>
    </>
  );
});

export const recoveredBufferDiffDialog = defineModal<boolean>()({
  id: 'recoveredBufferDiff',
  component: RecoveredBufferDiffDialog,
  size: 'lg',
});
