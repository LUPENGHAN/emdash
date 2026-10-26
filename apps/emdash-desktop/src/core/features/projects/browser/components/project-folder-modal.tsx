import { Button, Dialog, Field, Input } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';

type ProjectFolderModalArgs =
  | { mode: 'create'; projectId: string }
  | { mode: 'rename'; folderId: string; currentName: string };

export const ProjectFolderModal = observer(function ProjectFolderModal(
  args: ProjectFolderModalArgs
) {
  const { complete, dismiss } = useModalController('projectFolderModal');
  const currentName = args.mode === 'rename' ? args.currentName : '';
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const isEmpty = trimmedName.length === 0;
  const isTooLong = trimmedName.length > 64;
  const isUnchanged = args.mode === 'rename' && trimmedName === currentName;
  const isValid = !isEmpty && !isTooLong && !isUnchanged;

  const handleSubmit = useCallback(async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const projects = getProjectManagerStore();
      if (args.mode === 'create') {
        await projects.createProjectFolder(trimmedName, args.projectId);
      } else {
        await projects.renameProjectFolder(args.folderId, trimmedName);
      }
      complete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save folder');
      setIsSubmitting(false);
    }
  }, [args, complete, isSubmitting, isValid, trimmedName]);

  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>{args.mode === 'create' ? 'New folder' : 'Rename folder'}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="pt-0">
        <Field.Group>
          <Field.Root>
            <Field.Label>Folder name</Field.Label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              autoFocus
            />
            {isEmpty && (
              <p className="text-destructive mt-1 text-xs">
                Folder name must be 1 to 64 characters.
              </p>
            )}
            {isTooLong && (
              <p className="text-destructive mt-1 text-xs">
                Folder name must be 1 to 64 characters.
              </p>
            )}
            {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
          </Field.Root>
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" onClick={dismiss}>
          Cancel
        </Button>
        <ConfirmButton
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={!isValid || isSubmitting}
        >
          {isSubmitting ? 'Saving...' : args.mode === 'create' ? 'Create' : 'Rename'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const projectFolderModal = defineModal<void>()({
  id: 'projectFolderModal',
  component: ProjectFolderModal,
  size: 'xs',
});
