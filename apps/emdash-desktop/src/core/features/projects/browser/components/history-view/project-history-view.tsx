import { Button, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { History } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import type { ImportableSession } from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';

const AGENT_NAMES: Record<ImportableSession['providerId'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * Sessions of Claude Code / Codex / OpenCode that were run in this project's directory
 * outside Emdash. Resuming one opens it as a task on the project checkout itself (no
 * worktree), since the CLIs resume a session in the directory it was started in.
 */
export const ProjectHistoryView = observer(function ProjectHistoryView({
  projectId,
}: {
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const queryClient = useQueryClient();
  const project = asAvailableProject(getProjectStore(projectId))?.project;
  const repositoryWorkspaceId = project?.repositoryWorkspaceId ?? null;
  const [resumingId, setResumingId] = useState<string | null>(null);

  const queryKey = ['projectImportableSessions', projectId];
  const { data: sessions, isLoading } = useQuery({
    queryKey,
    queryFn: async () =>
      (await getConversationsClient()).listProjectImportableSessions({ projectId }),
  });

  const resume = async (session: ImportableSession) => {
    const taskManager = getTaskManagerStore(projectId);
    if (!taskManager || !repositoryWorkspaceId || resumingId) return;
    setResumingId(session.sessionId);
    const taskId = crypto.randomUUID();
    const title = session.title.slice(0, 80);
    try {
      await taskManager.createTask({
        id: taskId,
        projectId,
        taskConfig: { version: '1', name: title },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: { kind: 'repository-instance', workspaceId: repositoryWorkspaceId },
        },
      });
      const created = await (
        await getConversationsClient()
      ).createConversation({
        id: crypto.randomUUID(),
        projectId,
        taskId,
        provider: session.providerId,
        title,
        type: 'pty',
        providerSessionId: session.sessionId,
        // The task view opens its initial conversation as the first tab on load.
        isInitialConversation: true,
      });
      if (!created.success) throw new Error(created.error.type);
      navigate(taskViewDef({ projectId, taskId }));
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      log.error('resume external session failed', error);
      toast.error(`Could not resume the session: ${String(error)}`);
    } finally {
      setResumingId(null);
    }
  };

  if (isLoading) {
    return <p className="p-4 text-sm text-foreground-muted">Looking for sessions…</p>;
  }

  if (!sessions?.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-foreground-muted">
        <History className="size-5" />
        <p>
          No Claude Code, Codex or OpenCode sessions found for {project?.path ?? 'this project'}.
        </p>
        <p className="text-xs">
          Sessions started in this directory from a terminal or IDE show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      <p className="mb-3 text-xs text-foreground-muted">
        Sessions started in {project?.path} outside Emdash. Resuming opens one as a task on the
        project directory.
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {sessions.map((session) => (
          <li key={session.sessionId} className="flex items-center gap-3 px-3 py-2.5">
            <AgentIcon id={session.providerId} size={16} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground" title={session.firstMessage ?? ''}>
                {session.title}
              </p>
              <p className="text-xs text-foreground-muted">
                {AGENT_NAMES[session.providerId]} ·{' '}
                {formatDistanceToNow(session.updatedAt, { addSuffix: true })}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={!repositoryWorkspaceId || resumingId !== null}
              onClick={() => void resume(session)}
            >
              {resumingId === session.sessionId ? 'Resuming…' : 'Resume'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
});
