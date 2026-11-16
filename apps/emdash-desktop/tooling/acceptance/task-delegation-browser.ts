import { asAgentProviderId } from '@emdash/plugins/agents/types';
import { when } from 'mobx';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { getCoordinationClient } from '@core/features/coordination/api/browser/client';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';

/** Test renderer entry: normal typed clients and stores, with isolated paths supplied by the harness. */
export async function prepareDelegationCaller(input: {
  wrapper: string;
  repository: string;
  worktreeRoot: string;
  sourceTask: string;
  sourceConversation: string;
}): Promise<string> {
  const { project, manager } = await prepareProject(input);
  if (!project.repositoryWorkspaceId) throw new Error('The repository workspace is unavailable.');
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

async function prepareProject(input: {
  wrapper: string;
  repository: string;
  worktreeRoot: string;
  name?: string;
  baselineBranch?: string;
  directory?: boolean;
}) {
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
    name: input.name ?? 'Delegation acceptance',
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
      ...(!input.directory && {
        gitIdentity: {
          stored: { defaultBranch: { remote: null, branch: input.baselineBranch ?? 'main' } },
        },
      }),
    },
  });
  if (!saved.success) throw new Error(JSON.stringify(saved.error));
  const manager = getTaskManagerStore(project.id);
  if (!manager || !project.repositoryWorkspaceId)
    throw new Error('The source project is not ready.');
  return { project, manager };
}

export async function prepareCoordinator(input: {
  wrapper: string;
  mainWrapper: string;
  repository: string;
  worktreeRoot: string;
  name?: string;
  directory?: boolean;
}) {
  const { project } = await prepareProject(input);
  const agents = await getAgentsClient();
  const selected = await agents.setUsedInstallation({
    host: { type: 'local', id: 'local' },
    id: 'opencode',
    selection: { kind: 'path', path: input.mainWrapper },
  });
  if (!selected.success) throw new Error(JSON.stringify(selected.error));
  const client = await getCoordinationClient();
  const record = (await client.list()).find((entry) => entry.projectId === project.id);
  if (!record) throw new Error('Project main agent was not created.');
  await client.update({
    id: record.id,
    primary: { agent: 'opencode', connection: 'official', effort: null },
  });
  getSidebarStore().revealProject(project.id);
  return { projectId: project.id, taskId: record.taskId, conversationId: record.conversationId };
}

export async function coordinatorSnapshot(taskId: string) {
  return (await getCoordinationClient()).getByTask({ taskId });
}

export async function createReplacementMain(input: { projectId: string; taskId: string }) {
  const manager = getConversationsForTask(input.taskId);
  if (!manager) throw new Error('Main agent conversations are unavailable.');
  return manager.createConversation({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    taskId: input.taskId,
    provider: asAgentProviderId('opencode'),
    title: 'Replacement main',
    type: 'acp',
    modelSource: null,
    effort: null,
  });
}

export async function prepareAdditionalProject(input: {
  wrapper: string;
  repository: string;
  worktreeRoot: string;
  name: string;
  baselineBranch: string;
}) {
  const { project } = await prepareProject(input);
  return project.id;
}

export async function allCoordinatorSnapshots() {
  return (await getCoordinationClient()).list();
}

export async function coordinatorDelegationStatus(id: string, taskId: string) {
  return (await getCoordinationClient()).delegationStatus({ id, taskId });
}

export async function createTerminalMain(input: { projectId: string; taskId: string }) {
  const manager = getConversationsForTask(input.taskId);
  if (!manager) throw new Error('Main agent conversations are unavailable.');
  const conversation = await manager.createConversation({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    taskId: input.taskId,
    provider: asAgentProviderId('claude'),
    title: 'Terminal main',
    type: 'pty',
    modelSource: null,
    effort: 'high',
    initialSize: { cols: 120, rows: 36 },
  });
  const result = await (
    await getConversationsClient()
  ).hydrateConversation({
    projectId: input.projectId,
    taskId: input.taskId,
    conversationId: conversation.id,
    initialSize: { cols: 120, rows: 36 },
  });
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return conversation;
}

export async function readCoordinatorDocument(taskId: string, path: string, revision?: string) {
  const client = await getCoordinationClient();
  const record = await client.getByTask({ taskId });
  if (!record) throw new Error('Main agent is unavailable.');
  return client.readDocument({ id: record.id, path, revision });
}
