import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { openModal } from '@core/manifests/browser/modal-api';

/**
 * Shown while the active file's buffer is a recovered draft that predates the
 * current disk text. The draft stays editable, but plain saves run the
 * conflict dialog instead of silently overwriting newer disk work.
 */
export const RecoveredStaleBanner = observer(function RecoveredStaleBanner({
  tab,
}: {
  tab: FileTabResource;
}) {
  const entry = tab.entry;
  if (!entry?.recoveredStale) return null;
  const ref = tab.ref;

  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-background-secondary px-2 py-1 text-xs text-foreground-muted"
      tabIndex={0}
      role="note"
    >
      <span className="min-w-0 flex-1 truncate">
        Unsaved changes from an earlier session. The file has changed on disk since.
      </span>
      <Button
        variant="secondary"
        size="xs"
        title="Discard the recovered draft and reload the file from disk"
        onClick={() => openFileStore.reloadFromDisk(entry)}
      >
        Reload from disk
      </Button>
      {ref && (
        <Button
          variant="secondary"
          size="xs"
          title="Compare the recovered draft with the current disk text"
          onClick={() => {
            void openModal('recoveredBufferDiff', { ref, path: tab.displayPath });
          }}
        >
          Compare
        </Button>
      )}
    </div>
  );
});
