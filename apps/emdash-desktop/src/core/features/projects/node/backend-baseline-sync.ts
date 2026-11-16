import { formatHostRef } from '@emdash/core/primitives/host/api';
import { gitContract, localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import type { Scope } from '@emdash/shared/concurrency';
import { eq, isNull, and } from 'drizzle-orm';
import type { GitCredentialsService } from '@core/features/github/api/node/services/git-credentials-service';
import { createBackgroundProjectAccess } from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { resolveProjectEffectiveSettings } from '@core/features/projects/api/node/settings/effective-settings';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import { isManagementBranch } from '@core/primitives/workspaces/api/management-branch';
import type { AppDb } from '@core/services/app-db/node/db';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { projects } from '@core/services/app-db/node/schema';
import { runRuntimeLiveJob } from '@core/services/runtime-clients/node/live-job';
import type {
  ProjectBaselineRecord,
  ProjectBaselineTarget,
  ProjectBaselineObservation,
} from '../api/baseline-sync';
import { ProjectBaselineSyncService, type BaselineSyncDependencies } from './baseline-sync-service';

type Dependencies = {
  db: AppDb;
  scope: Scope;
  projects: ProjectAttachmentManager;
  credentials: Pick<GitCredentialsService, 'mintOperationCredentials'>;
  verification: Pick<
    BaselineSyncDependencies,
    'verify' | 'recoverVerification' | 'cleanupVerification'
  >;
  changed?(projectId: string): void;
};

export function createBackendProjectBaselineSync(deps: Dependencies) {
  const projectFor = createBackgroundProjectAccess(deps.projects, deps.scope);
  const projectAt = async (target: ProjectBaselineTarget) => {
    const project = await projectFor(target.projectId);
    if (
      project.repoPath !== target.checkout ||
      formatHostRef(project.host) !== formatHostRef(target.host) ||
      project.project.repositoryWorkspaceId !== target.workspaceId
    )
      throw new Error('The Project baseline context changed. Check it again.');
    return project;
  };
  const readLocal = async (target: ProjectBaselineTarget) => {
    const project = await projectAt(target);
    const result = await project.git.checkout.getCommit({
      checkout: hostPathFromNative(target.checkout),
      hash: target.baselineRef,
    });
    if (!result.success)
      throw new Error(`Could not inspect the local baseline: ${result.error.type}`);
    return result.data.commit?.hash ?? null;
  };
  return new ProjectBaselineSyncService({
    store: new AppDbKeyValueStore<Record<string, ProjectBaselineRecord>>(
      deps.db,
      'project-baselines'
    ),
    changed: deps.changed,
    authorize: async (projectId, intent) => {
      deps.scope.signal.throwIfAborted();
      const [project] = await deps.db
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
        .limit(1);
      if (!project || (intent === 'control' && project.archivedAt))
        throw new Error('The Project is unavailable or archived.');
    },
    resolve: async (projectId) => {
      const project = await projectFor(projectId);
      if (!project.hasRepository || !project.project.repositoryWorkspaceId)
        throw new Error('A code baseline requires a Git Project.');
      const effective = await resolveProjectEffectiveSettings({
        settings: project.settings,
        repoFacts: project.repoFacts,
        projectId,
      });
      if (effective.defaultBranch.provenance.kind === 'broken-setting')
        throw new Error('The configured code baseline is unavailable. Select it explicitly.');
      const branch = effective.defaultBranch.value;
      if (!branch) throw new Error('Configure the Project code baseline before delegating.');
      if (isManagementBranch(branch.branch))
        throw new Error('Management branches cannot be code baselines.');
      if (branch.remote === null && effective.baseRemote.provenance.kind === 'broken-setting')
        throw new Error('The configured upstream is unavailable. Select it explicitly.');
      const remote = branch.remote ?? effective.baseRemote.value;
      const trees = await project.git.repository.listWorktrees(project.repository);
      if (!trees.success)
        throw new Error(`Could not identify the Project repository: ${trees.error.type}`);
      const main = trees.data.worktrees.find((entry) => entry.isMain);
      if (!main) throw new Error('The Project repository has no primary checkout identity.');
      return {
        projectId,
        host: project.host,
        checkout: project.repoPath,
        workspaceId: project.project.repositoryWorkspaceId,
        repositoryKey: JSON.stringify([formatHostRef(project.host), main.worktreePath]),
        baselineRef: localBranchRefSchema.parse(`refs/heads/${branch.branch}`),
        remote,
        upstreamRef: remote ? localBranchRefSchema.parse(`refs/heads/${branch.branch}`) : null,
      };
    },
    synchronize: async (target): Promise<ProjectBaselineObservation> => {
      if (target.remote === null) {
        const oid = await readLocal(target);
        return { kind: 'local', beforeOid: oid, oid, upstreamOid: null, remoteFingerprint: null };
      }
      if (!target.upstreamRef) throw new Error('The baseline upstream ref is unavailable.');
      const project = await projectAt(target);
      const lease = await deps.credentials.mintOperationCredentials({
        projectId: target.projectId,
        host: target.host,
      });
      try {
        const result = await runRuntimeLiveJob(
          gitContract.checkout.syncBaseline,
          project.git.checkout.syncBaseline,
          {
            checkout: hostPathFromNative(target.checkout),
            remote: target.remote,
            upstreamRef: target.upstreamRef,
            baselineRef: target.baselineRef,
            credentials: lease?.credentials,
          },
          undefined,
          { signal: deps.scope.signal }
        );
        if (result.success)
          return {
            kind: result.data.kind,
            beforeOid: result.data.beforeOid,
            oid: result.data.afterOid,
            upstreamOid: result.data.upstreamOid,
            remoteFingerprint: result.data.remoteFingerprint,
            ...(result.data.kind === 'blocked' && { reason: result.data.reason }),
          };
        const observation = result.error.observation;
        return {
          kind: 'unavailable',
          beforeOid: observation?.beforeOid ?? null,
          oid: observation?.afterOid ?? null,
          upstreamOid: observation?.upstreamOid ?? null,
          remoteFingerprint: observation?.remoteFingerprint ?? null,
          reason: result.error.type,
          message: result.error.message,
        };
      } finally {
        lease?.release();
      }
    },
    readLocal,
    ...deps.verification,
  });
}
