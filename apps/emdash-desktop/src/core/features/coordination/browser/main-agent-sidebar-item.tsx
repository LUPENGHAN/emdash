import { toast } from '@emdash/ui/react/primitives';
import { Bot, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { getCoordinationClient } from '../api/browser/client';

export function MainAgentSidebarItem({
  projectId,
  nested,
}: {
  projectId: string;
  nested: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { navigate } = useNavigate();
  return (
    <button
      type="button"
      disabled={busy}
      aria-label="Open main agent"
      className={`flex h-8 w-full items-center gap-2 rounded-lg text-sm hover:bg-background-tertiary-1 ${nested ? 'pl-10' : 'pl-7'}`}
      onClick={() => {
        setBusy(true);
        void getCoordinationClient()
          .then((client) => client.openProject({ projectId }))
          .then(async (record) => {
            const manager = getTaskManagerStore(projectId);
            if (!manager) throw new Error('The project is not available.');
            await manager.loadTasks();
            navigate(taskViewDef({ projectId, taskId: record.taskId }));
          })
          .catch((error) =>
            toast.error('Could not open main agent', { description: String(error) })
          )
          .finally(() => setBusy(false));
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
      <span>Main agent</span>
    </button>
  );
}
