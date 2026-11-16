import { createHash } from 'node:crypto';
import type { ScriptRunState } from '@emdash/core/runtimes/scripts/api';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import type { Scope } from '@emdash/shared/concurrency';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';
import { hostPathFromNative, joinHostPath } from '@core/primitives/desktop-runtime/api';
import type { BaselineVerification, ProjectBaselineAttempt } from '../api/baseline-sync';
import type { BaselineSyncDependencies } from './baseline-sync-service';

type VerificationHost = {
  pool: string;
  registry: Pick<
    ProjectProvider['workspaceRegistry'],
    'createWorktree' | 'getProjectConfig' | 'records'
  >;
  git: Pick<ProjectProvider['git']['checkout'], 'readHead'>;
  scripts: Pick<HostRuntimesClient['scripts'], 'start' | 'wait' | 'runs'>;
};

type Dependencies = {
  scope: Scope;
  resolve(attempt: ProjectBaselineAttempt): Promise<VerificationHost>;
};

function identity(attempt: ProjectBaselineAttempt) {
  const key = createHash('sha256')
    .update(
      JSON.stringify([attempt.target, attempt.revision, attempt.id, attempt.observation?.oid])
    )
    .digest('hex');
  return { workspaceId: `baseline-check-${key}`, branch: `emdash/verify/${key}` };
}

/** Verification uses a pinned checkout; receipts outlive the desktop and never replay a script. */
export function createBaselineVerification(
  deps: Dependencies
): Pick<BaselineSyncDependencies, 'verify' | 'recoverVerification'> {
  const options = () => ({ signal: deps.scope.signal, timeoutMs: 0 });
  const assertHead = async (
    host: VerificationHost,
    path: string,
    attempt: ProjectBaselineAttempt
  ) => {
    const head = await host.git.readHead({ checkout: hostPathFromNative(path) }, options());
    if (!head.success)
      throw new Error(`Cannot inspect the verification checkout: ${head.error.type}`);
    if (head.data.kind === 'unborn' || head.data.oid !== attempt.observation?.oid)
      throw new Error('The verification checkout no longer contains the pinned baseline commit.');
  };
  const assertWorkspace = async (
    host: VerificationHost,
    attempt: ProjectBaselineAttempt,
    receipt: BaselineVerification
  ) => {
    const expected = identity(attempt);
    if (!receipt.workspacePath || receipt.workspaceId !== expected.workspaceId)
      throw new Error(
        'The verification workspace receipt is missing or does not match this check.'
      );
    const records = await host.registry.records.state(undefined, 'list').snapshot();
    const record = records.data[expected.workspaceId];
    if (
      !record ||
      record.kind !== 'worktree' ||
      record.observedStatus !== 'present' ||
      record.path !== receipt.workspacePath ||
      record.parentId !== attempt.target.workspaceId ||
      record.creation?.branch !== expected.branch ||
      record.creation.baseRef !== attempt.observation?.oid ||
      record.creation.purpose !== undefined ||
      record.lastCreateOutcome?.status !== 'succeeded'
    )
      throw new Error(
        'The verification workspace is unavailable or its creation identity changed.'
      );
    await assertHead(host, receipt.workspacePath, attempt);
  };
  const settle = async (
    host: VerificationHost,
    attempt: ProjectBaselineAttempt,
    receipt: BaselineVerification,
    run: ScriptRunState
  ): Promise<BaselineVerification> => {
    if (run.runId !== receipt.runId || run.script !== 'prepare')
      return { ...receipt, status: 'unknown', message: 'The verification run identity changed.' };
    if (run.status === 'running')
      return { ...receipt, status: 'unknown', message: 'The verification run has not settled.' };
    await assertWorkspace(host, attempt, receipt);
    return {
      ...receipt,
      status: run.status === 'succeeded' && run.exitCode === 0 ? 'succeeded' : 'failed',
      exitCode: run.exitCode,
      output: run.outputTail,
      message:
        run.message ?? (run.status !== 'succeeded' ? `Verification ${run.status}.` : undefined),
    };
  };
  const wait = async (
    host: VerificationHost,
    attempt: ProjectBaselineAttempt,
    receipt: BaselineVerification
  ) => {
    if (!receipt.workspacePath || !receipt.runId)
      throw new Error('Cannot wait for verification without a confirmed run receipt.');
    const result = await host.scripts.wait(
      { workspacePath: receipt.workspacePath, script: 'prepare', runId: receipt.runId },
      options()
    );
    if (!result.success)
      return {
        ...receipt,
        status: 'unknown' as const,
        message: 'The verification run is unavailable.',
      };
    return settle(host, attempt, receipt, result.data);
  };

  return {
    verify: async (attempt, save) => {
      if (!attempt.verificationConfig || !attempt.observation?.oid)
        throw new Error('Baseline verification requires a command and a pinned commit.');
      const host = await deps.resolve(attempt);
      const expected = identity(attempt);
      const workspacePath = joinHostPath(host.pool, expected.workspaceId);
      let receipt: BaselineVerification = {
        status: 'starting',
        workspaceId: expected.workspaceId,
        workspacePath,
        output: '',
      };
      // Persist the artifact identity before starting any Host mutation.
      await save(receipt);
      const created = await host.registry.createWorktree(
        {
          workspaceId: expected.workspaceId,
          repositoryId: attempt.target.workspaceId,
          path: workspacePath,
          branch: expected.branch,
          baseRef: attempt.observation.oid,
          preservePatterns: [],
        },
        options()
      );
      if (!created.success)
        throw new Error(`Cannot create the verification checkout: ${created.error.type}`);
      await assertWorkspace(host, attempt, receipt);
      const config = await host.registry.getProjectConfig({ workspaceId: expected.workspaceId });
      if (!config.success) throw new Error('Cannot resolve the verification workspace settings.');
      const started = await host.scripts.start(
        {
          workspacePath,
          script: 'prepare',
          provenance: 'manual',
          facts: {
            workspaceId: expected.workspaceId,
            repositoryPath: attempt.target.checkout,
            branch: expected.branch,
            defaultBranch: attempt.target.baselineRef.slice('refs/heads/'.length),
          },
          command: attempt.verificationConfig.command,
          timeoutMs: attempt.verificationConfig.timeoutMs,
          shellSetup: config.data.resolved.shellSetup?.value ?? '',
          env: config.data.resolved.env.value,
        },
        options()
      );
      if (!started.success)
        return {
          ...receipt,
          status: 'failed',
          message: `Cannot start verification: ${started.error.type}`,
        };
      receipt = { ...receipt, status: 'running', runId: started.data.runId };
      await save(receipt);
      return started.data.status === 'running'
        ? wait(host, attempt, receipt)
        : settle(host, attempt, receipt, started.data);
    },
    recoverVerification: async (attempt) => {
      const receipt = attempt.verification ?? { status: 'unknown', output: '' };
      if (!receipt.runId || !receipt.workspacePath)
        return {
          ...receipt,
          status: 'unknown',
          message:
            'No confirmed verification run receipt is available. Retry the check explicitly.',
        };
      try {
        const host = await deps.resolve(attempt);
        await assertWorkspace(host, attempt, receipt);
        const runs = await host.scripts.runs
          .state({ workspacePath: receipt.workspacePath }, 'current')
          .snapshot();
        const run = runs.data.prepare;
        if (!run || run.runId !== receipt.runId)
          return {
            ...receipt,
            status: 'unknown',
            message: 'The Host no longer retains this verification run.',
          };
        return run.status === 'running'
          ? await wait(host, attempt, receipt)
          : await settle(host, attempt, receipt, run);
      } catch (error) {
        return {
          ...receipt,
          status: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
