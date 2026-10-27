import { ContextMenu } from '@emdash/ui/react/primitives';
import { ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef } from 'react';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { cn } from '@core/primitives/styling/browser/cn';
import { SidebarItemMiniButton, SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

export const SidebarFolderHeader = observer(function SidebarFolderHeader({
  folderId,
}: {
  folderId: string;
}) {
  const folder = getProjectManagerStore().folders.find((entry) => entry.id === folderId);
  const collapsed = getSidebarStore().isFolderCollapsed(folderId);
  const press = useRef<{ x: number; y: number } | null>(null);
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
        <SidebarMenuRow
          className="group/row h-8 px-1"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            press.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            const start = press.current;
            press.current = null;
            if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return;
            getSidebarStore().toggleFolderCollapsed(folderId);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <SidebarItemMiniButton
              type="button"
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                getSidebarStore().toggleFolderCollapsed(folderId);
              }}
            >
              <ChevronRight
                className={cn(
                  'h-4 w-4 shrink-0 text-foreground/70 transition-transform',
                  !collapsed && 'rotate-90'
                )}
              />
            </SidebarItemMiniButton>
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
