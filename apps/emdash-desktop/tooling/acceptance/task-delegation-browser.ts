import { asAgentProviderId } from '@emdash/plugins/agents/types';
import { when } from 'mobx';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import { getCoordinationClient } from '@core/features/coordination/api/browser/client';
import { getIntegrationsClient } from '@core/features/integrations/api/browser/client';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import {
  asAvailableProject,
  getProjectStore,
  getProjectViewStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { getTaskPrAssociationStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { openModal } from '@core/manifests/browser/modal-api';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import { getPullRequestsRuntimeClient } from '@core/services/pull-requests/api/client';

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
  return {
    id: record.id,
    projectId: project.id,
    taskId: record.taskId,
    conversationId: record.conversationId,
  };
}

export async function coordinatorSnapshot(taskId: string) {
  return (await getCoordinationClient()).getByTask({ taskId });
}

/** Creates resources through normal APIs; the stopped-app harness attaches the legacy KV record. */
export async function prepareLegacyCoordinatorFixture(input: {
  wrapper: string;
  repository: string;
  worktreeRoot: string;
}) {
  const { project, manager } = await prepareProject({
    ...input,
    name: 'Legacy management fixture',
  });
  const client = await getCoordinationClient();
  const record = (await client.list()).find((entry) => entry.projectId === project.id);
  if (!record) throw new Error('Missing legacy main identity');
  await client.update({
    id: record.id,
    primary: { agent: 'opencode', connection: 'official', effort: null },
  });
  const params: CreateTaskParams = {
    id: record.taskId,
    projectId: project.id,
    taskConfig: {
      version: '1',
      name: 'Main agent',
      role: 'coordination',
      initialConversation: {
        id: record.conversationId,
        provider: asAgentProviderId('opencode'),
        type: 'acp',
        title: 'Legacy main',
        modelSource: null,
        effort: null,
      },
    },
    workspaceConfig: {
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: `legacy-main-${record.taskId.slice(0, 8)}`,
        fromBranch: { type: 'local', branch: 'main' },
      },
      workspace: { kind: 'new-worktree' },
    },
  };
  await manager.createTask(params);
  await manager.provisionTask(record.taskId);
  const task = getTaskStore(project.id, record.taskId);
  if (!task?.workspacePath) throw new Error('Legacy workspace was not provisioned');
  return {
    id: record.id,
    projectId: project.id,
    taskId: record.taskId,
    conversationId: record.conversationId,
    params,
    path: task.workspacePath,
  };
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

export function openBaselineFixtureSettings(projectId: string) {
  const view = getProjectViewStore(projectId);
  if (!view) throw new Error('The fixture Project view is unavailable.');
  view.setProjectView('settings');
  getNavigation().navigate(projectViewDef({ projectId }));
}

export async function baselineFixtureState(projectId: string) {
  return (await (await getProjectsWireClient()).baseline.state({ projectId }, 'current').snapshot())
    .data;
}

export async function observeMergedPrFixture(input: { repositoryUrl: string; number: number }) {
  const result = await (
    await getPullRequestsRuntimeClient()
  ).refreshPullRequest({ ...input, policy: 'force' });
  if (!result.success) throw new Error(result.error.type);
}

export async function coordinatorDelegationStatus(id: string, taskId: string) {
  return (await getCoordinationClient()).delegationStatus({ id, taskId });
}

export async function archiveFixtureProject(projectId: string) {
  await (await getProjectsWireClient()).archiveProject({ projectId });
}

export async function deleteFixtureProject(projectId: string) {
  await (await getProjectsWireClient()).deleteProject({ projectId });
}

export async function configurePrFixture(input: {
  projectId: string;
  apiBaseUrl: string;
  baseRemote?: string;
  apiToken?: string;
  systemGitCredentials?: boolean;
}) {
  const connected = await (
    await getIntegrationsClient()
  ).connect({
    integrationId: 'gitlab',
    credentials: {
      apiToken: input.apiToken ?? 'fixture-only-token',
      instanceUrl: input.apiBaseUrl,
    },
    displayName: 'Isolated forge fixture',
  });
  if (!connected.success) throw new Error(connected.error);
  const saved = await (
    await getProjectsWireClient()
  ).updateProjectSettings({
    projectId: input.projectId,
    patch: {
      gitIdentity: {
        stored: {
          baseRemote: input.baseRemote ?? 'upstream',
          pushRemote: 'personal',
          defaultBranch: { remote: 'upstream', branch: 'main' },
          ...(input.systemGitCredentials && { agentGitCredentials: 'system' as const }),
        },
      },
      integrationAccounts: {
        stored: { gitlab: { kind: 'account', accountId: connected.accountId } },
      },
    },
  });
  if (!saved.success) throw new Error(JSON.stringify(saved.error));
  return connected.accountId;
}

/** Distinct native Git and project-pinned API identities, with a different app default. */
export async function configurePrAccountsFixture(input: { projectId: string; apiBaseUrl: string }) {
  const integrations = await getIntegrationsClient();
  const source = await integrations.connect({
    integrationId: 'gitlab',
    credentials: { apiToken: 'fixture-source-token', instanceUrl: input.apiBaseUrl },
    displayName: 'Default account fixture',
  });
  if (!source.success) throw new Error(source.error);
  const targetAccountId = await configurePrFixture({
    ...input,
    apiToken: 'fixture-target-token',
    systemGitCredentials: true,
  });
  const selected = await integrations.setDefaultAccount({
    integrationId: 'gitlab',
    accountId: source.accountId,
  });
  if (!selected.success) throw new Error(selected.error);
  return { defaultAccountId: source.accountId, targetAccountId };
}

export function readPrFixtureAssociation(input: { projectId: string; taskId: string }) {
  const task = getTaskStore(input.projectId, input.taskId);
  return task
    ? getTaskPrAssociationStore(task).pullRequests.map((pr) => ({
        url: pr.url,
        repositoryUrl: pr.repositoryUrl,
      }))
    : [];
}

export function openPrFixtureDialog(input: {
  projectId: string;
  taskId: string;
  workspaceId: string;
  repositoryUrl: string;
  branchName: string;
}) {
  void openModal('createPrModal', { ...input, draft: false });
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
