import { when } from 'mobx';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';

/** Test renderer entry: normal typed clients and stores, with isolated paths supplied by the harness. */
export async function prepareDelegationCaller(input: {
  wrapper: string;
  repository: string;
  worktreeRoot: string;
  sourceTask: string;
  sourceConversation: string;
}): Promise<string> {
  const agents = await getAgentsClient();
  const selected = await agents.setUsedInstallation({
    host: { type: 'local', id: 'local' },
    id: 'claude',
    selection: { kind: 'path', path: input.wrapper },
  });
  if (!selected.success) throw new Error(JSON.stringify(selected.error));
  const projects = await getProjectsWireClient();
  const created = await projects.createProject({
    type: 'local',
    name: 'Delegation acceptance',
    path: input.repository,
  });
  if (!created.success) throw new Error(JSON.stringify(created.error));
  const project = created.data;
  await when(() => asAvailableProject(getProjectStore(project.id))?.host.state.kind === 'ready', {
    timeout: 20000,
  });
  const saved = await projects.updateProjectSettings({
    projectId: project.id,
    patch: {
      placement: { stored: { worktreeRoot: input.worktreeRoot } },
      gitIdentity: { stored: { defaultBranch: { remote: null, branch: 'main' } } },
    },
  });
  if (!saved.success) throw new Error(JSON.stringify(saved.error));
  const manager = getTaskManagerStore(project.id);
  if (!manager || !project.repositoryWorkspaceId)
    throw new Error('The source project is not ready.');
  await manager.createTask({
    id: input.sourceTask,
    projectId: project.id,
    taskConfig: {
      version: '1',
      name: 'Source agent',
      initialConversation: {
        id: input.sourceConversation,
        provider: 'claude',
        type: 'pty',
        title: 'Source',
        initialPrompt: 'Wait',
        modelSource: null,
        effort: 'low',
      },
    },
    workspaceConfig: {
      version: '2',
      git: { kind: 'none' },
      workspace: {
        kind: 'repository-instance',
        workspaceId: project.repositoryWorkspaceId,
      },
    },
  });
  const conversations = await getConversationsClient();
  const launched = await conversations.hydrateConversation({
    projectId: project.id,
    taskId: input.sourceTask,
    conversationId: input.sourceConversation,
  });
  if (!launched.success) throw new Error(JSON.stringify(launched.error));
  return project.id;
}
