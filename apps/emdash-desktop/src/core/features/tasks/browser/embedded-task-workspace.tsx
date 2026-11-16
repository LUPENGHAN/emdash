import { Button } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import {
  getTaskManagerStore,
  getTaskStore,
  taskViewKind,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import {
  TaskViewWrapper,
  useTaskViewContext,
} from '@core/features/tasks/contributions/browser/task-view-context';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { ReadyTaskMainPanel, TaskViewLoadingState } from './main-panel';

/** Hosts an editor workspace without navigating away or changing the owning task's context. */
export const EmbeddedTaskWorkspace = observer(function EmbeddedTaskWorkspace({
  projectId,
  taskId,
  children,
}: {
  projectId: string;
  taskId: string;
  children: (workspace: ReactNode) => ReactNode;
}) {
  const owner = useTaskViewContext();
  const manager = getTaskManagerStore(projectId);
  const loaded = useQuery({
    queryKey: ['embedded-task-workspace', projectId, taskId],
    enabled: !!manager,
    queryFn: async () => {
      if (!manager) throw new Error('The workspace project is unavailable.');
      await manager.loadTasks();
      const task = getTaskStore(projectId, taskId);
      if (!task) throw new Error('The workspace task is unavailable.');
      if (taskViewKind(task, projectId) !== 'ready') await manager.provisionTask(taskId);
      if (taskViewKind(task, projectId) !== 'ready')
        throw new Error('The workspace could not be prepared.');
      task.activate();
      const composition = getTaskComposition(projectId, taskId);
      if (!composition) throw new Error('The workspace editor is unavailable.');
      await composition.space.ready;
      return true;
    },
  });
  const task = getTaskStore(projectId, taskId);
  const composition = getTaskComposition(projectId, taskId);
  return (
    <projectAvailabilityUi.Boundary projectId={projectId}>
      {loaded.error ? (
        <div className="space-y-2 p-4" role="alert">
          <p>{String(loaded.error)}</p>
          <Button variant="secondary" onClick={() => void loaded.refetch()}>
            Retry document workspace
          </Button>
        </div>
      ) : !loaded.data ||
        taskViewKind(task, projectId) !== 'ready' ||
        !composition?.space.isHydrated ? (
        <TaskViewLoadingState label="Loading document workspace…" />
      ) : (
        <TaskViewWrapper
          projectId={projectId}
          taskId={taskId}
          purpose="documents"
          navigationTaskId={owner.navigationTaskId ?? owner.taskId}
        >
          {children(<ReadyTaskMainPanel />)}
        </TaskViewWrapper>
      )}
    </projectAvailabilityUi.Boundary>
  );
});
