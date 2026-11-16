import { parseRepositoryRef } from '@emdash/core/primitives/repository/api';
import { gitContract, localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import type { Scope } from '@emdash/shared/concurrency';
import { and, eq, isNull } from 'drizzle-orm';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { BackgroundAgentAccess } from '@core/features/agent-control/api/node/background-access';
import type { GitCredentialsService } from '@core/features/github/api/node/services/git-credentials-service';
import { createBackgroundProjectAccess } from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { resolveProjectEffectiveSettings } from '@core/features/projects/api/node/settings/effective-settings';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { isManagementBranch } from '@core/primitives/workspaces/api/management-branch';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { projects as projectRows, tasks } from '@core/services/app-db/node/schema';
import type { PullRequestsRuntimeClient } from '@core/services/pull-requests/api/client';
import { runRuntimeLiveJob } from '@core/services/runtime-clients/node/live-job';
import type {
  SourceControlRuntimeBroker,
  SourceControlWorkspaceIdentityResolver,
} from '../api/runtime-adapter';
import type { TaskPullRequestRecord, TaskPullRequestPlan } from '../api/task-pull-requests';
import { TaskPullRequestService, TaskPullRequestFailure } from './task-pull-request-service';

type Dependencies = {
  db: AppDb;
  scope: Scope;
  projects: ProjectAttachmentManager;
  workspaceIdentity: SourceControlWorkspaceIdentityResolver;
  runtimes: SourceControlRuntimeBroker;
  credentials: Pick<GitCredentialsService, 'mintOperationCredentials'>;
  pullRequests(): Promise<PullRequestsRuntimeClient>;
  refreshRepositoryInterest(projectId: string): Promise<void>;
  access: Pick<BackgroundAgentAccess, 'mayAccessTask'>;
  assertCaller(caller: AgentCaller): Promise<void>;
  changed?(taskId: string): void;
};

function hostedRepository(input: string) {
  if (!input.includes('://') && !/^[^@\s]+@[^:\s]+:/.test(input))
    throw new Error('The selected remote must identify a hosted repository for this PR.');
  const parsed = parseRepositoryRef(input);
  if (!parsed) throw new Error('The selected PR repository is invalid.');
  return parsed;
}

export function createBackendTaskPullRequests(deps: Dependencies) {
  const projectFor = createBackgroundProjectAccess(deps.projects, deps.scope);
  const task = async (taskId: string) => {
    const [row] = await deps.db
      .select()
      .from(tasks)
      .innerJoin(projectRows, eq(tasks.projectId, projectRows.id))
      .innerJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
      .where(
        and(
          eq(tasks.id, taskId),
          isNull(tasks.deletedAt),
          isNull(projectRows.deletedAt),
          isNull(workspaces.untrackedAt)
        )
      )
      .limit(1);
    if (!row || row.tasks.archivedAt || row.projects.archivedAt)
      throw new Error('The PR task, project or workspace is unavailable or archived.');
    if (row.tasks.type === 'coordination' || row.workspaces.config?.git.kind === 'management')
      throw new Error('Management documents cannot be used as a code pull request source.');
    if (row.workspaces.kind !== 'worktree')
      throw new Error('Choose a code task with its own Git worktree for this PR.');
    return { id: row.tasks.id, projectId: row.tasks.projectId, workspaceId: row.workspaces.id };
  };
  const runtime = async (
    plan: Pick<TaskPullRequestPlan, 'taskId' | 'projectId' | 'workspaceId'>
  ) => {
    const current = await task(plan.taskId);
    if (current.projectId !== plan.projectId || current.workspaceId !== plan.workspaceId)
      throw new Error('The task workspace changed. Prepare a separate PR request.');
    await projectFor(plan.projectId);
    const identity = await deps.workspaceIdentity.resolve(plan.workspaceId);
    if (!identity || identity.projectId !== plan.projectId)
      throw new Error('The PR workspace host is unavailable.');
    const client = await deps.runtimes.client(identity.host);
    if (!client.success) throw new Error(`The PR host is unavailable: ${client.error.type}`);
    return { identity, git: client.data.git, checkout: hostPathFromNative(identity.path) };
  };
  const publishedOid = async (
    plan: Pick<
      TaskPullRequestPlan,
      'taskId' | 'projectId' | 'workspaceId' | 'sourceRef' | 'pushTarget'
    >
  ) => {
    const host = await runtime(plan);
    const lease = await deps.credentials.mintOperationCredentials({
      projectId: plan.projectId,
      host: host.identity.host,
    });
    try {
      const read = await host.git.checkout.readRemoteBranch(
        {
          checkout: host.checkout,
          remote: plan.pushTarget.remote,
          expectedRemoteFingerprint: plan.pushTarget.fingerprint,
          branch: plan.sourceRef,
          credentials: lease?.credentials,
        },
        { timeoutMs: 0 }
      );
      if (!read.success)
        throw new Error(`Could not verify the published PR source: ${JSON.stringify(read.error)}`);
      if (!read.data.oid)
        throw new Error('The source branch is not published on the selected push remote.');
      return read.data.oid;
    } finally {
      lease?.release();
    }
  };
  const check = async (plan: TaskPullRequestPlan, published = false) => {
    const host = await runtime(plan);
    const [head, remote] = await Promise.all([
      host.git.checkout.model.state({ checkout: host.checkout }, 'head').snapshot(),
      host.git.checkout.inspectPushTarget({
        checkout: host.checkout,
        remote: plan.pushTarget.remote,
      }),
    ]);
    if (
      head.data.kind !== 'branch' ||
      head.data.ref !== plan.sourceRef ||
      (plan.push !== false && head.data.oid !== plan.oid)
    )
      throw new Error('The source branch or commit changed. Prepare a separate PR request.');
    if (!remote.success || remote.data.fingerprint !== plan.pushTarget.fingerprint)
      throw new Error('The pinned push destination changed or is unavailable.');
    if (published && (await publishedOid(plan)) !== plan.oid)
      throw new Error('The published source commit changed. Prepare a separate PR request.');
  };
  return new TaskPullRequestService({
    store: new AppDbKeyValueStore<Record<string, TaskPullRequestRecord>>(
      deps.db,
      'task-pull-requests'
    ),
    changed: deps.changed,
    authorize: async (taskId, caller, intent = 'control') => {
      if (caller) await deps.assertCaller(caller);
      const [target] = await deps.db
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .innerJoin(projectRows, eq(tasks.projectId, projectRows.id))
        .where(
          and(
            eq(tasks.id, taskId),
            isNull(tasks.deletedAt),
            isNull(projectRows.deletedAt),
            isNull(projectRows.archivedAt)
          )
        )
        .limit(1);
      if (!target) throw new Error('The PR task or project is unavailable.');
      if (intent === 'control') await task(taskId);
      if (caller && !(await deps.access.mayAccessTask(caller, target, intent)))
        throw new Error('Only this task or its current responsible main agent can create its PR.');
      // A worker with cross-project grants may control child tasks, but may open PRs only for itself.
      if (caller && caller.taskId !== taskId && intent === 'control') {
        const [source] = await deps.db
          .select({ type: tasks.type })
          .from(tasks)
          .where(and(eq(tasks.id, caller.taskId), isNull(tasks.deletedAt)))
          .limit(1);
        if (source?.type !== 'coordination')
          throw new Error('A task agent can create pull requests only for its own task.');
      }
    },
    prepare: async (input) => {
      const target = await task(input.taskId);
      if (input.workspaceId && input.workspaceId !== target.workspaceId)
        throw new Error('The task workspace changed. Reopen the PR dialog before preparing it.');
      const project = await projectFor(target.projectId);
      const host = await runtime({ ...target, taskId: target.id });
      const [effective, head, remotes] = await Promise.all([
        resolveProjectEffectiveSettings({
          settings: project.settings,
          repoFacts: project.repoFacts,
          projectId: target.projectId,
        }),
        host.git.checkout.model.state({ checkout: host.checkout }, 'head').snapshot(),
        project.git.repository.model.state(project.repository, 'remotes').snapshot(),
      ]);
      if (head.data.kind !== 'branch' || isManagementBranch(head.data.ref))
        throw new Error('Choose a committed code task branch for this PR.');
      const branch = head.data.ref.slice('refs/heads/'.length);
      if (input.sourceBranch && input.sourceBranch !== branch)
        throw new Error('The selected source branch is not checked out in the task.');
      if (!input.pushRemote && effective.pushRemote.provenance.kind === 'broken-setting')
        throw new Error(
          'The configured push remote is unavailable. Select a push remote explicitly.'
        );
      if (!input.repositoryUrl && effective.baseRemote.provenance.kind === 'broken-setting')
        throw new Error(
          'The configured base remote is unavailable. Select the PR target explicitly.'
        );
      if (!input.base && effective.defaultBranch.provenance.kind === 'broken-setting')
        throw new Error('The configured target branch is unavailable. Select a base explicitly.');
      const remote = input.pushRemote ?? effective.pushRemote.value;
      if (!remote) throw new Error('Select a push remote for this task PR.');
      const push = await host.git.checkout.inspectPushTarget({ checkout: host.checkout, remote });
      if (!push.success) throw new Error(`Could not inspect the push target: ${push.error.type}`);
      const source = hostedRepository(push.data.destination);
      const baseRemote = remotes.data.remotes.find(
        (entry) => entry.name === effective.baseRemote.value
      );
      const repository = hostedRepository(input.repositoryUrl ?? baseRemote?.url ?? '');
      const base = input.base ?? effective.defaultBranch.value?.branch;
      if (!base) throw new Error('Select the target branch for this task PR.');
      localBranchRefSchema.parse(`refs/heads/${base}`);
      if (source.host !== repository.host)
        throw new Error('PR source and target must use the same host.');
      const oid =
        input.push === false
          ? await publishedOid({
              ...target,
              taskId: target.id,
              sourceRef: head.data.ref,
              pushTarget: push.data,
            })
          : head.data.oid;
      return {
        taskId: target.id,
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        sourceRef: head.data.ref,
        oid,
        push: input.push ?? true,
        pushTarget: push.data,
        headRepositoryUrl: source.repositoryUrl,
        repositoryUrl: repository.repositoryUrl,
        base,
        title: input.title,
        body: input.body,
        draft: input.draft,
      };
    },
    check,
    push: async (plan) => {
      const host = await runtime(plan);
      const lease = await deps.credentials.mintOperationCredentials({
        projectId: plan.projectId,
        host: host.identity.host,
      });
      try {
        const pushed = await runRuntimeLiveJob(
          gitContract.checkout.pushBranch,
          host.git.checkout.pushBranch,
          {
            checkout: host.checkout,
            remote: plan.pushTarget.remote,
            expectedRemoteFingerprint: plan.pushTarget.fingerprint,
            sourceRef: plan.sourceRef,
            targetRef: plan.sourceRef,
            oid: plan.oid,
            credentials: lease?.credentials,
          }
        );
        if (!pushed.success)
          throw new Error(`Task PR push failed: ${JSON.stringify(pushed.error)}`);
      } finally {
        lease?.release();
      }
    },
    ensure: async (plan) => {
      await deps.refreshRepositoryInterest(plan.projectId);
      const client = await deps.pullRequests();
      const registered = await client.registerRepository({ repositoryUrl: plan.repositoryUrl });
      if (!registered.success)
        throw new Error(`PR target registration failed: ${JSON.stringify(registered.error)}`);
      const created = await client.ensurePullRequest({
        projectId: plan.projectId,
        repositoryUrl: plan.repositoryUrl,
        headRepositoryUrl: plan.headRepositoryUrl,
        head: plan.sourceRef.slice('refs/heads/'.length),
        base: plan.base,
        title: plan.title,
        body: plan.body,
        draft: plan.draft,
      });
      if (!created.success) throw new TaskPullRequestFailure(created.error);
      return created.data;
    },
  });
}
