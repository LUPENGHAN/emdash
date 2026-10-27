import { ContextMenu, Tooltip } from '@emdash/ui/react/primitives';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderClosed,
  FolderInput,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect } from 'react';
import { ConnectionStatusDot } from '@core/features/machines/contributions/browser/connection-status-dot';
import {
  isUnregisteredProject,
  type ProjectCreationStage,
} from '@core/features/projects/api/browser/stores/project';
import {
  getProjectHostAccess,
  getProjectManagerStore,
  getProjectStore,
  projectViewKind,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { useConfirmDeleteProject } from '@core/features/projects/contributions/browser/use-confirm-delete-project';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { taskHostActionAvailability } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import {
  useNavigate,
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  SidebarItemMiniButton,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuRow,
} from './sidebar-primitives';

const UNREGISTERED_STAGE_LABEL: Record<ProjectCreationStage, string> = {
  'creating-repo': 'Creating repository…',
  cloning: 'Cloning…',
  registering: 'Registering…',
};

export const SidebarProjectItem = observer(function SidebarProjectItem({
  projectId,
  nested = false,
  archived = false,
}: {
  projectId: string;
  nested?: boolean;
  archived?: boolean;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const projectParams = useViewParams(projectViewDef);
  const taskParams = useViewParams(taskViewDef);
  const openCreateTaskModal = useOpenModal('taskModal');
  const confirmDeleteProject = useConfirmDeleteProject();
  const openRenameProject = useOpenModal('renameProjectModal');
  const openProjectFolder = useOpenModal('projectFolderModal');

  const project = getProjectStore(projectId);

  const prefetchRepository = useCallback(() => {
    const repo = getGitRepositoryStore(projectId);
    void repo?.localData.load();
    void repo?.remoteData.load();
  }, [projectId]);

  const currentProjectId =
    currentView === 'task'
      ? taskParams?.projectId
      : currentView === 'project'
        ? projectParams?.projectId
        : null;
  const currentTaskId = currentView === 'task' ? taskParams?.taskId : null;

  const isProjectActive = currentProjectId === projectId && !currentTaskId;

  useEffect(() => {
    if (isProjectActive) prefetchRepository();
  }, [isProjectActive, prefetchRepository]);

  const isExpanded = getSidebarStore().expandedProjectIds.has(projectId);

  if (!project) return null;

  const sshConnectionId = project.data?.type === 'ssh' ? project.data.connectionId : null;
  const isSshProject = sshConnectionId !== null;
  const hostAccess = getProjectHostAccess(projectId);
  const hostAccessState = hostAccess?.state;
  const displayedSshConnectionState =
    !hostAccessState || hostAccessState.kind !== 'ready'
      ? hostAccessState &&
        ['connecting', 'provisioning', 'handshaking', 'attaching', 'recovering'].includes(
          hostAccessState.situation
        )
        ? 'connecting'
        : 'disconnected'
      : 'connected';
  const ProjectIcon = isSshProject ? FolderInput : isExpanded ? FolderOpen : FolderClosed;
  const projectLabel = project.name ?? 'project';
  const createAvailability = taskHostActionAvailability(projectId);
  const createDisabledReason =
    createAvailability.kind === 'disabled'
      ? (projectAvailabilityUi.getLiveActionDisabledReason(projectId) ??
        projectAvailabilityUi.defaultLiveActionDisabledReason)
      : undefined;
  const navigateToProject = () => navigate(projectViewDef({ projectId }));

  const renderSpinnerWithTooltip = () => {
    if (!isUnregisteredProject(project)) return null;
    const label =
      project.creation.kind === 'failed'
        ? 'Failed'
        : UNREGISTERED_STAGE_LABEL[project.creation.stage];
    return (
      <Tooltip.Root>
        <Tooltip.Trigger>
          <SidebarItemMiniButton type="button" disabled aria-label="Loading">
            <Loader2 className="h-4 w-4 animate-spin text-foreground/60" />
          </SidebarItemMiniButton>
        </Tooltip.Trigger>
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip.Root>
    );
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <SidebarMenuRow
          className={cn('group/row h-8 justify-between flex px-1', nested && 'pl-4')}
          data-active={isProjectActive || undefined}
          isActive={isProjectActive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={archived ? undefined : navigateToProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {project.state === 'unregistered' ? (
              renderSpinnerWithTooltip()
            ) : archived ? (
              <FolderClosed className="mx-1 h-4 w-4 shrink-0 text-foreground/70" />
            ) : (
              <SidebarItemMiniButton
                type="button"
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${projectLabel}`}
                className="relative"
                onClick={(e) => {
                  e.stopPropagation();
                  getSidebarStore().toggleProjectExpanded(projectId);
                }}
              >
                <ProjectIcon className="absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0" />
                <ChevronRight
                  className={cn(
                    'absolute h-4 w-4 transition-all duration-150 opacity-0 group-hover/row:opacity-100',
                    isExpanded && 'rotate-90'
                  )}
                />
              </SidebarItemMiniButton>
            )}
            <SidebarMenuAction
              aria-label={`Open project ${projectLabel}`}
              className={cn(
                'truncate transition-colors select-none',
                projectViewKind(getProjectStore(projectId)) === 'hydrating' &&
                  'text-foreground-tertiary-passive'
              )}
            >
              {isSshProject ? (
                <span className="flex min-w-0 items-center gap-2">
                  <span translate="no" className="truncate">
                    {project.name}
                  </span>
                  <ConnectionStatusDot state={displayedSshConnectionState} />
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span translate="no" className="truncate">
                    {project.name}
                  </span>
                  {projectViewKind(project) === 'context_error' && (
                    <Tooltip.Root>
                      <Tooltip.Trigger>
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                      </Tooltip.Trigger>
                      <Tooltip.Content>Project context unavailable</Tooltip.Content>
                    </Tooltip.Root>
                  )}
                </span>
              )}
            </SidebarMenuAction>
          </div>
          {!archived && (
            <Tooltip.Root>
              <Tooltip.Trigger
                className="h-6"
                render={
                  <SidebarItemMiniButton
                    type="button"
                    aria-label={
                      createDisabledReason
                        ? `New task for ${projectLabel}. ${createDisabledReason}`
                        : `New task for ${projectLabel}`
                    }
                    className={
                      'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100'
                    }
                    onPointerEnter={() => prefetchRepository()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openCreateTaskModal({ projectId });
                    }}
                    disabled={project.state === 'unregistered' || !!createDisabledReason}
                  >
                    <Plus className="h-4 w-4" />
                  </SidebarItemMiniButton>
                }
              />
              <Tooltip.Content>
                {createDisabledReason ?? (
                  <>
                    New Task
                    <BoundShortcut command="app.newTask" variant="keycaps" />
                  </>
                )}
              </Tooltip.Content>
            </Tooltip.Root>
          )}
        </SidebarMenuRow>
      </ContextMenu.Trigger>
      <ContextMenu.Content>
        {archived ? (
          <ContextMenu.Item
            onClick={() => {
              void getProjectManagerStore().restoreProject(projectId);
            }}
          >
            <ArchiveRestore className="size-4" />
            Restore
          </ContextMenu.Item>
        ) : (
          <ProjectFolderMenu
            projectId={projectId}
            disabled={project.state === 'unregistered'}
            folderId={project.data?.folderId ?? null}
            onNewFolder={() => {
              void openProjectFolder({ mode: 'create', projectId });
            }}
            onRename={() => {
              void openRenameProject({ projectId, currentName: project.name ?? '' });
            }}
          />
        )}
        {archived ? null : <ContextMenu.Separator />}
        {!archived && (
          <ContextMenu.Item
            disabled={project.state === 'unregistered'}
            onClick={() => {
              void getProjectManagerStore().archiveProject(projectId);
            }}
          >
            <Archive className="size-4" />
            Archive Project
          </ContextMenu.Item>
        )}
        <ContextMenu.Separator />
        <ContextMenu.Item
          variant="destructive"
          onClick={() => {
            void confirmDeleteProject({
              projectId,
              projectLabel: project.name ?? 'this project',
            });
          }}
        >
          <Trash2 className="size-4" />
          Remove Project
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
});

const ProjectFolderMenu = observer(function ProjectFolderMenu({
  projectId,
  disabled,
  folderId,
  onNewFolder,
  onRename,
}: {
  projectId: string;
  disabled: boolean;
  folderId: string | null;
  onNewFolder: () => void;
  onRename: () => void;
}) {
  const folders = getProjectManagerStore().folders;
  return (
    <>
      <ContextMenu.Item disabled={disabled} onClick={onRename}>
        <Pencil className="size-4" />
        Rename Project
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Group>
        <ContextMenu.Label>Move to Folder</ContextMenu.Label>
        <ContextMenu.Item disabled={disabled} onClick={onNewFolder}>
          New Folder…
        </ContextMenu.Item>
        {folders.map((folder) => (
          <ContextMenu.Item
            key={folder.id}
            disabled={disabled || folder.id === folderId}
            onClick={() => {
              void getProjectManagerStore().moveProjectToFolder(projectId, folder.id);
            }}
          >
            <span translate="no">{folder.name}</span>
          </ContextMenu.Item>
        ))}
        <ContextMenu.Item
          disabled={disabled || folderId == null}
          onClick={() => {
            void getProjectManagerStore().moveProjectToFolder(projectId, null);
          }}
        >
          No Folder
        </ContextMenu.Item>
      </ContextMenu.Group>
    </>
  );
});

interface BaseProjectItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive: boolean;
}

export function BaseProjectItem({ isActive, className, ...props }: BaseProjectItemProps) {
  return (
    <SidebarMenuButton
      className={cn('justify-between flex item px-1 py-1', className)}
      isActive={isActive}
      {...props}
    />
  );
}
