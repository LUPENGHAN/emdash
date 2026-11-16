import type { HostRef } from '@emdash/core/primitives/host/api';
import { asAgentProviderId } from '@emdash/plugins/agents/types';
import type { Scope } from '@emdash/shared/concurrency';
import { and, eq } from 'drizzle-orm';
import { getPlugin } from '@core/features/agents/api/node/plugin-registry';
import { assertModelEffort } from '@core/features/model-providers/api/model-effort';
import {
  projectBaselineSelectionSchema,
  type ProjectBaselineSelection,
} from '@core/features/projects/api/baseline-sync';
import { createBackgroundProjectAccess } from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { resolveProjectEffectiveSettings } from '@core/features/projects/api/node/settings/effective-settings';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import { resolveTaskBranchName, type CreateTaskParams } from '@core/primitives/tasks/api';
import type { WorkspaceConfig } from '@core/primitives/workspaces/api';
import { isManagementBranch } from '@core/primitives/workspaces/api/management-branch';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { tasks } from '@core/services/app-db/node/schema';
import type { AgentCaller, AgentControlAction } from '../api';
import { delegationModelSelection } from '../api/model-selection';
import {
  TaskDelegationService,
  type DelegationRecord,
  type TaskDelegationDependencies,
  type PreparedTaskDelegation,
} from './task-delegation-service';

type Dependencies = {
  db: AppDb;
  scope: Scope;
  projects: ProjectAttachmentManager;
  taskService: Pick<TaskService, 'createTask' | 'provisionWorkspace'>;
  getAcpOptions(host: HostRef, agentId: string): Promise<Record<string, string | boolean>>;
  startConversation(params: CreateTaskParams): Promise<void>;
  getAgentSettings(agentId: string): Promise<ProviderCustomConfig | undefined>;
  getBranchDefaults(): Promise<{ branchPrefix?: string; appendRandomBranchSuffix?: boolean }>;
  prepareBaseline?(projectId: string): Promise<ProjectBaselineSelection>;
  authorize(
    caller: AgentCaller,
    targetProjectId: string,
    request?: Extract<AgentControlAction, { kind: 'create_task' }>
  ): Promise<void>;
  getBlocker?(taskId: string): Promise<string | null>;
  onCreated?(taskId: string): Promise<void>;
  recoveryContext?: TaskDelegationDependencies['recoveryContext'];
  onStateChange?: TaskDelegationDependencies['onStateChange'];
  onPrepared?(
    caller: AgentCaller,
    params: CreateTaskParams,
    request: Extract<AgentControlAction, { kind: 'create_task' }>
  ): Promise<void>;
  getDelegationDefaults?(
    caller: AgentCaller
  ): Promise<Partial<Extract<AgentControlAction, { kind: 'create_task' }>>>;
};

/** Retains project attachment while background tasks need their runtime. */
export function createBackendTaskDelegation(deps: Dependencies): TaskDelegationService {
  const projectFor = createBackgroundProjectAccess(deps.projects, deps.scope);
  return new TaskDelegationService({
    store: new AppDbKeyValueStore<Record<string, DelegationRecord>>(deps.db, 'agent-delegations'),
    authorize: deps.authorize,
    onPrepared: deps.onPrepared,
    getBlocker: deps.getBlocker,
    onCreated: deps.onCreated,
    recoveryContext: deps.recoveryContext,
    onStateChange: deps.onStateChange,
    prepare: async (caller, request, ids): Promise<PreparedTaskDelegation> => {
      const defaults =
        ids.role === 'coordination' ? undefined : await deps.getDelegationDefaults?.(caller);
      request = {
        ...defaults,
        ...Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)),
      } as typeof request;
      const projectId = request.projectId ?? caller.projectId;
      const project = await projectFor(projectId);
      if (!project.hasRepository && ids.role !== 'coordination')
        throw new Error('A code task needs a Git repository.');
      const baselineSelection =
        ids.role !== 'coordination' && !request.baseBranch && deps.prepareBaseline
          ? projectBaselineSelectionSchema.parse(await deps.prepareBaseline(projectId))
          : undefined;
      if (
        baselineSelection &&
        (baselineSelection.target.projectId !== projectId ||
          isManagementBranch(baselineSelection.target.baselineRef))
      )
        throw new Error('The approved baseline does not belong to the target code Project.');
      let git: WorkspaceConfig['git'];
      let workspace: WorkspaceConfig['workspace'] = { kind: 'new-worktree' };
      if (!project.hasRepository) {
        const workspaceId = project.project.repositoryWorkspaceId;
        if (!workspaceId) throw new Error('The directory project workspace is unavailable.');
        git = { kind: 'none' };
        workspace = { kind: 'repository-instance', workspaceId };
      } else if (ids.role === 'coordination')
        git = { kind: 'management', branchName: `emdash/manage/${ids.taskId}` };
      else {
        const effective = await resolveProjectEffectiveSettings({
          settings: project.settings,
          repoFacts: project.repoFacts,
          projectId,
        });
        const remotes = (
          await project.git.repository.model.state(project.repository, 'remotes').snapshot()
        ).data.remotes;
        let base = effective.defaultBranch.value;
        if (request.baseBranch) {
          const remote = remotes.find((entry) => request.baseBranch!.startsWith(entry.name + '/'));
          base = remote
            ? { remote: remote.name, branch: request.baseBranch.slice(remote.name.length + 1) }
            : { remote: null, branch: request.baseBranch };
        }
        if (!base) throw new Error('Configure the target project code baseline before delegating.');
        if (isManagementBranch(base.branch))
          throw new Error('Management branches cannot be code task baselines.');
        const baseRemote = base.remote
          ? remotes.find((entry) => entry.name === base.remote)
          : undefined;
        if (base.remote && !baseRemote) throw new Error('The code baseline remote is unavailable.');
        const branchDefaults = await deps.getBranchDefaults();
        const slug =
          request.name
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'task';
        const branchName = resolveTaskBranchName({
          rawBranch: slug,
          branchPrefix: branchDefaults.branchPrefix ?? '',
          suffix: ids.taskId.slice(0, 8),
          appendRandomSuffix: branchDefaults.appendRandomBranchSuffix ?? true,
        });
        git = {
          kind: 'create-branch',
          branchName,
          // A local source accepts Git revisions. Use the reviewed full OID so a queued
          // task cannot move with either the local baseline or a remote tracking ref.
          fromBranch: baselineSelection
            ? { type: 'local', branch: baselineSelection.oid }
            : baseRemote
              ? { type: 'remote', branch: base.branch, remote: baseRemote }
              : { type: 'local', branch: base.branch },
        };
      }
      if (ids.role === 'coordination' && !request.prompt)
        return {
          id: ids.taskId,
          projectId,
          taskConfig: { version: '1', name: request.name, role: 'coordination' },
          workspaceConfig: { version: '2', git, workspace },
        };
      const agentId = request.providerId ?? caller.providerId;
      const plugin = getPlugin(agentId);
      const type = request.ui === 'chat' ? 'acp' : 'pty';
      if (type === 'acp' && plugin.capabilities.acp.kind !== 'supported')
        throw new Error('This agent does not support structured chat. Select terminal explicitly.');
      const saved = request.prompt ? await deps.getAgentSettings(agentId) : undefined;
      const explicit = delegationModelSelection(request);
      const modelSource =
        explicit.modelSource !== undefined ? explicit.modelSource : (saved?.modelSource ?? null);
      const sourceModel =
        explicit.sourceModel ??
        (modelSource === saved?.modelSource ? saved?.sourceModel : undefined);
      if (request.prompt && modelSource === 'gateway:models' && !sourceModel)
        throw new Error('Select a gateway model for the delegated task.');
      const preferences =
        type === 'acp' && request.prompt
          ? await deps.getAcpOptions(project.host, agentId)
          : undefined;
      const preferenceEffort = preferences?.[agentId === 'codex' ? 'reasoning_effort' : 'effort'];
      const effort =
        request.effort !== undefined
          ? request.effort
          : (saved?.effort ??
            (typeof preferenceEffort === 'string' && preferenceEffort !== 'default'
              ? preferenceEffort
              : null));
      if (request.prompt) assertModelEffort(effort, plugin.capabilities.effort, agentId);
      const sessionOptions = Object.fromEntries(
        Object.entries(preferences ?? {}).filter(
          ([key]) =>
            key !== 'effort' &&
            key !== 'reasoning_effort' &&
            (modelSource === null || key !== 'model')
        )
      );
      if (typeof effort === 'string')
        sessionOptions[agentId === 'codex' ? 'reasoning_effort' : 'effort'] = effort;
      return {
        id: ids.taskId,
        projectId,
        ...(baselineSelection && { baselineSelection }),
        taskConfig: {
          version: '1',
          name: request.name,
          ...(ids.role && { role: ids.role }),
          ...(request.prompt && {
            initialConversation: {
              id: ids.conversationId,
              provider: asAgentProviderId(agentId),
              title: request.name,
              type,
              modelSource,
              sourceModel,
              effort,
              ...(explicit.supplierId && { supplierId: explicit.supplierId }),
              ...(type === 'acp'
                ? {
                    initialQueue: [{ text: request.prompt }],
                    options: {
                      ...sessionOptions,
                      ...(modelSource === null && request.model ? { model: request.model } : {}),
                    },
                  }
                : {
                    initialPrompt: request.prompt,
                    ...(modelSource === null && request.model ? { model: request.model } : {}),
                  }),
            },
          }),
        },
        workspaceConfig: {
          version: '2',
          git,
          workspace,
        },
      };
    },
    findTask: async (id, projectId) => {
      const [row] = await deps.db
        .select({ deleted: tasks.deletedAt, archived: tasks.archivedAt })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)))
        .limit(1);
      return !row ? 'missing' : row.deleted || row.archived ? 'deleted' : 'available';
    },
    create: async (params) => {
      await projectFor(params.projectId);
      const result = await deps.taskService.createTask(params);
      if (!result.success) throw new Error(`Task creation failed: ${JSON.stringify(result.error)}`);
    },
    activate: async (id, projectId) => {
      await projectFor(projectId);
      const result = await deps.taskService.provisionWorkspace(id, deps.scope.signal);
      if (!result.success)
        throw new Error(`Workspace activation failed: ${JSON.stringify(result.error)}`);
      return { path: result.data.path };
    },
    start: (params) => deps.startConversation(params),
  });
}
