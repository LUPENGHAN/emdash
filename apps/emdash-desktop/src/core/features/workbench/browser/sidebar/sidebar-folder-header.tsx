import { ContextMenu } from '@emdash/ui/react/primitives';
import { FolderClosed, Pencil, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

export const SidebarFolderHeader = observer(function SidebarFolderHeader({
  folderId,
}: {
  folderId: string;
}) {
  const folder = getProjectManagerStore().folders.find((entry) => entry.id === folderId);
  const openProjectFolder = useOpenModal('projectFolderModal');
  const confirm = useOpenModal('confirmActionModal');
  if (!folder) return null;

  const deleteFolder = async () => {
    const outcome = await confirm({
      title: 'Delete Folder',
      description: `Delete folder "${folder.name}"? Its projects stay in the list, ungrouped.`,
      confirmLabel: 'Delete',
    });
    if (!outcome.success) return;
    await getProjectManagerStore().deleteProjectFolder(folderId);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <SidebarMenuRow className="group/row h-8 px-1" onMouseDown={(e) => e.preventDefault()}>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <FolderClosed className="h-4 w-4 shrink-0 text-foreground/70" />
            <SidebarMenuAction className="truncate font-medium">
              <span translate="no">{folder.name}</span>
            </SidebarMenuAction>
          </div>
        </SidebarMenuRow>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item
          onClick={() => {
            void openProjectFolder({
              mode: 'rename',
              folderId,
              currentName: folder.name,
            });
          }}
        >
          <Pencil className="size-4" />
          Rename
        </ContextMenu.Item>
        <ContextMenu.Item
          variant="destructive"
          onClick={() => {
            void deleteFolder();
          }}
        >
          <Trash2 className="size-4" />
          Delete Folder
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
});
