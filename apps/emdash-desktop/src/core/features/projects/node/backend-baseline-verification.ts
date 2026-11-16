import { formatHostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import type { Scope } from '@emdash/shared/concurrency';
import { createBackgroundProjectAccess } from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { WorkspacePlacementResolver } from '@core/features/workspaces/api/node/placement/workspace-placement-resolver';
import { createBaselineVerification } from './baseline-verification';

type Dependencies = {
  scope: Scope;
  projects: ProjectAttachmentManager;
  runtimes: Pick<RuntimeBroker, 'client'>;
  placement: Pick<WorkspacePlacementResolver, 'resolveWorktreePool'>;
};

export function createBackendBaselineVerification(deps: Dependencies) {
  const projectFor = createBackgroundProjectAccess(deps.projects, deps.scope);
  return createBaselineVerification({
    scope: deps.scope,
    resolve: async (attempt, intent = 'create') => {
      const project = await projectFor(attempt.target.projectId);
      if (
        project.repoPath !== attempt.target.checkout ||
        formatHostRef(project.host) !== formatHostRef(attempt.target.host) ||
        project.project.repositoryWorkspaceId !== attempt.target.workspaceId
      )
        throw new Error('The Project moved before baseline verification. Check it again.');
      const pool =
        intent === 'create' ? await deps.placement.resolveWorktreePool(project.project) : null;
      if (pool && !pool.success)
        throw new Error(`Cannot place the verification checkout: ${pool.error.type}`);
      const runtime = await deps.runtimes.client(project.host);
      if (!runtime.success)
        throw new Error(`The verification Host is unavailable: ${runtime.error.type}`);
      return {
        pool: pool?.success ? pool.data : undefined,
        registry: project.workspaceRegistry,
        git: project.git.checkout,
        scripts: runtime.data.scripts,
      };
    },
  });
}
