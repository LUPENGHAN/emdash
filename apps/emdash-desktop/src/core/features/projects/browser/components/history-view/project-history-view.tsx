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
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
  cursor: 'Cursor',
};

/** Where a session ran, when it was not the project directory itself. */
export function sessionLocationLabel(cwd: string, projectPath: string | undefined): string | null {
  if (!projectPath || cwd === projectPath) return null;
  const name = cwd.split('/').filter(Boolean).pop() ?? cwd;
  if (cwd.includes('/.claude/worktrees/')) return `Claude worktree · ${name}`;
  if (cwd.includes('/.codex/worktrees/')) return `Codex worktree · ${name}`;
  if (cwd.includes('/emdash/worktrees/')) return `Emdash worktree · ${name}`;
  return `Worktree · ${name}`;
}

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

  // Chat UI loads the session with ACP session/load and replays its history;
  // terminal resumes it with the CLI's own --resume.
  const resume = async (session: ImportableSession, type: 'acp' | 'pty') => {
    const taskManager = getTaskManagerStore(projectId);
    // Resume where the session ran: the checkout or the worktree it was started in.
    const workspaceId = session.workspaceId ?? repositoryWorkspaceId;
    if (!taskManager || !workspaceId || resumingId) return;
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
          workspace: { kind: 'repository-instance', workspaceId },
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
        type,
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
          Sessions started in this directory or its worktrees from a terminal or IDE show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      <p className="mb-3 text-xs text-foreground-muted">
        Sessions started in {project?.path} and its worktrees outside Emdash. Resuming opens one as
        a task right where it ran, without creating a new worktree.
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
                {sessionLocationLabel(session.cwd, project?.path) ? (
                  <span className="text-foreground-passive">
                    {' · '}
                    {sessionLocationLabel(session.cwd, project?.path)}
                  </span>
                ) : null}
              </p>
            </div>
            {session.resumeIn ? null : (
              <Button
                size="sm"
                variant="ghost"
                title="Resume in a terminal, with the CLI's own interface"
                disabled={!(session.workspaceId ?? repositoryWorkspaceId) || resumingId !== null}
                onClick={() => void resume(session, 'pty')}
              >
                Terminal
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              title={
                session.resumeIn === 'pty'
                  ? 'Resume in a terminal (this session lives in the CLI’s terminal store)'
                  : 'Resume in the chat UI'
              }
              disabled={!(session.workspaceId ?? repositoryWorkspaceId) || resumingId !== null}
              // Sessions tied to one UI's store (Cursor) resume there; others default to chat.
              onClick={() => void resume(session, session.resumeIn ?? 'acp')}
            >
              {resumingId === session.sessionId ? 'Resuming…' : 'Resume'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
});
