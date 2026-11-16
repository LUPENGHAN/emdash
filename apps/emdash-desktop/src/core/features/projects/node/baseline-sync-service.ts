import { createHash, randomUUID } from 'node:crypto';
import type { gitContract } from '@emdash/core/runtimes/git/api';
import { KeyedMutex } from '@emdash/shared/concurrency';
import { redactSecrets } from '@emdash/shared/logger';
import type { JobResult } from '@emdash/wire/rpc';
import {
  baselineOidSchema,
  baselineVerificationSchema,
  projectBaselineConfigSchema,
  projectBaselineObservationSchema,
  projectBaselineRecord,
  projectBaselineTargetSchema,
  projectBaselineSelectionSchema,
  type BaselineVerification,
  type ProjectBaselineAttempt,
  type ProjectBaselineConfig,
  type ProjectBaselineObservation,
  type ProjectBaselineRecord,
  type ProjectBaselineSnapshot,
  type ProjectBaselineTarget,
  type ProjectBaselineTrigger,
} from '../api/baseline-sync';

export type BaselineSyncDependencies = {
  store: {
    getOrThrow(projectId: string): Promise<ProjectBaselineRecord | null>;
    setOrThrow(projectId: string, record: ProjectBaselineRecord): Promise<void>;
  };
  authorize(projectId: string, intent: 'read' | 'control'): Promise<void>;
  resolve(projectId: string): Promise<ProjectBaselineTarget>;
  synchronize(target: ProjectBaselineTarget): Promise<ProjectBaselineObservation>;
  readLocal(target: ProjectBaselineTarget): Promise<string | null>;
  verify(
    attempt: ProjectBaselineAttempt,
    receipt: (value: BaselineVerification) => Promise<void>
  ): Promise<BaselineVerification>;
  recoverVerification(attempt: ProjectBaselineAttempt): Promise<BaselineVerification>;
  changed?(projectId: string): void;
  now?(): number;
  id?(): string;
};

type GitBlocker = Extract<
  JobResult<typeof gitContract.checkout.syncBaseline>,
  { kind: 'blocked' }
>['reason'];
const gitBlockerMessages: Record<GitBlocker, string> = {
  'management-branch': 'Select a code baseline instead of a management branch.',
  'remote-changed':
    'The upstream remote changed during synchronization. Check its settings before retrying.',
  'symbolic-baseline':
    'The configured local baseline is a symbolic ref and cannot be updated safely.',
  'symbolic-checkpoint':
    'The saved upstream observation is a symbolic ref and cannot be updated safely.',
  'upstream-rewritten':
    'The upstream history was rewritten. Inspect the upstream before retrying; the local baseline was preserved.',
  'history-unavailable':
    'Git cannot establish the required ancestry. Restore the missing history before retrying.',
  'checked-out-elsewhere':
    'The code baseline is checked out in another worktree. Release that checkout before synchronizing.',
  'checkout-unavailable': 'The baseline checkout is unavailable. Restore it before retrying.',
  'checkout-busy':
    'The baseline checkout has a Git operation in progress. Finish it before retrying.',
  'checkout-dirty':
    'The baseline checkout has local changes. Commit or stash them before synchronizing.',
  'local-ahead':
    'The local baseline has unpublished commits. Resolve them explicitly before synchronizing.',
  diverged:
    'The local baseline and upstream have diverged. Resolve their histories explicitly before synchronizing.',
  'local-changed':
    'The local baseline changed during synchronization. Check its state before retrying.',
};

function gitBlockerMessage(reason: string | undefined): string {
  return reason && Object.hasOwn(gitBlockerMessages, reason)
    ? gitBlockerMessages[reason as GitBlocker]
    : 'Git could not safely update the baseline.';
}

function targetKey(target: ProjectBaselineTarget) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        target.projectId,
        target.repositoryKey,
        target.workspaceId,
        target.host,
        target.checkout,
        target.baselineRef,
        target.remote,
        target.upstreamRef,
      ])
    )
    .digest('hex');
}

/** Project policy owns approval; the Host owns Git and verification execution. */
export class ProjectBaselineSyncService {
  private readonly records = new KeyedMutex();
  private readonly repositories = new KeyedMutex();
  private readonly active = new Map<string, Promise<ProjectBaselineSnapshot>>();
  private readonly now: () => number;
  constructor(private readonly deps: BaselineSyncDependencies) {
    this.now = deps.now ?? Date.now;
  }
  private async load(projectId: string): Promise<ProjectBaselineRecord> {
    const saved = await this.deps.store.getOrThrow(projectId);
    if (!saved)
      return {
        version: '1',
        revision: 0,
        config: { verification: null },
        attempts: [],
        lastContactAt: null,
      };
    const parsed = projectBaselineRecord.safeParse(saved);
    if (parsed.status !== 'ok')
      throw new Error(`Cannot read Project baseline state: ${parsed.status}`);
    return parsed.data;
  }
  private view(projectId: string, record: ProjectBaselineRecord): ProjectBaselineSnapshot {
    const last = record.attempts.at(-1);
    let status: ProjectBaselineSnapshot['status'] =
      record.resolutionError?.revision === record.revision
        ? 'failed'
        : !last
          ? 'not-checked'
          : last.revision !== record.revision
            ? 'needs-check'
            : (last.phase === 'fetching' || last.phase === 'verifying') &&
                !this.active.has(projectId)
              ? 'interrupted'
              : last.phase;
    if (
      last &&
      (status === 'ready' || status === 'offline') &&
      record.config.verification &&
      !this.proofMatches(record, last)
    )
      status = 'needs-check';
    return {
      ...record,
      status,
      canDelegate: (status === 'ready' || status === 'offline') && !!last?.observation?.oid,
    };
  }
  async get(projectId: string) {
    await this.deps.authorize(projectId, 'read');
    return this.view(projectId, await this.load(projectId));
  }
  private async write(projectId: string, record: ProjectBaselineRecord) {
    await this.deps.store.setOrThrow(projectId, projectBaselineRecord.schema.parse(record));
    this.deps.changed?.(projectId);
  }
  async configure(projectId: string, expectedRevision: number, input: ProjectBaselineConfig) {
    await this.deps.authorize(projectId, 'control');
    const config = projectBaselineConfigSchema.parse(input);
    return this.records.runExclusive(projectId, async () => {
      const record = await this.load(projectId);
      if (record.revision !== expectedRevision)
        throw new Error('Baseline settings changed. Refresh before saving.');
      const updated = { ...record, revision: record.revision + 1, config, proof: undefined };
      await this.write(projectId, updated);
      return this.view(projectId, updated);
    });
  }
  private async save(
    projectId: string,
    attempt: ProjectBaselineAttempt,
    patch: Partial<
      Pick<ProjectBaselineRecord, 'proof' | 'denied' | 'lastContactAt' | 'resolutionError'>
    > = {}
  ): Promise<ProjectBaselineRecord> {
    return this.records.runExclusive(projectId, async () => {
      const record = await this.load(projectId);
      if (record.revision !== attempt.revision)
        throw new Error('Baseline settings changed during this check. Run it again.');
      const index = record.attempts.findIndex((entry) => entry.id === attempt.id);
      const attempts = [...record.attempts];
      if (index === -1) attempts.push(attempt);
      else attempts[index] = attempt;
      const updated = { ...record, ...patch, attempts };
      await this.write(projectId, updated);
      return updated;
    });
  }
  async synchronize(
    projectId: string,
    trigger: ProjectBaselineTrigger,
    options: { afterCurrent?: boolean } = {}
  ): Promise<ProjectBaselineSnapshot> {
    await this.deps.authorize(projectId, 'control');
    const pending = this.active.get(projectId);
    if (pending) {
      if (!options.afterCurrent) return pending;
      // A later observation needs a fetch after the running attempt has settled.
      await pending.catch(() => undefined);
      return this.synchronize(projectId, trigger);
    }
    const work = this.run(projectId, trigger);
    this.active.set(projectId, work);
    try {
      return await work;
    } finally {
      if (this.active.get(projectId) === work) {
        this.active.delete(projectId);
        this.deps.changed?.(projectId);
      }
    }
  }
  private cleanVerification(value: BaselineVerification) {
    const result = baselineVerificationSchema.parse(value);
    return {
      ...result,
      output: redactSecrets(result.output).slice(-16384),
      ...(result.message && { message: redactSecrets(result.message) }),
    };
  }
  private proofMatches(record: ProjectBaselineRecord, attempt: ProjectBaselineAttempt) {
    const proof = record.proof;
    return (
      !!proof &&
      proof.revision === attempt.revision &&
      proof.targetKey === targetKey(attempt.target) &&
      proof.oid === attempt.observation?.oid &&
      proof.remoteFingerprint === attempt.observation?.remoteFingerprint &&
      (!attempt.verificationConfig || proof.verification === 'succeeded')
    );
  }
  private deniedMatches(record: ProjectBaselineRecord, attempt: ProjectBaselineAttempt) {
    const denied = record.denied;
    return (
      !!denied &&
      denied.revision === attempt.revision &&
      denied.targetKey === targetKey(attempt.target) &&
      denied.oid === attempt.observation?.oid
    );
  }
  private async finish(
    projectId: string,
    attempt: ProjectBaselineAttempt,
    phase: 'ready' | 'offline',
    patch: Partial<Pick<ProjectBaselineRecord, 'proof' | 'denied'>> = {}
  ) {
    if ((await this.deps.readLocal(attempt.target)) !== attempt.observation?.oid)
      return await this.fail(
        projectId,
        attempt,
        'baseline-moved',
        'The baseline changed during verification.'
      );
    const completed = { ...attempt, phase, finishedAt: this.now() };
    return this.view(projectId, await this.save(projectId, completed, patch));
  }
  private async fail(
    projectId: string,
    attempt: ProjectBaselineAttempt,
    code: string,
    message: string,
    denial = false
  ) {
    const failed: ProjectBaselineAttempt = {
      ...attempt,
      phase: 'blocked',
      finishedAt: this.now(),
      error: { code, message: redactSecrets(message) },
    };
    const denied =
      denial && attempt.observation?.oid
        ? {
            revision: attempt.revision,
            targetKey: targetKey(attempt.target),
            oid: attempt.observation.oid,
            remoteFingerprint: attempt.observation.remoteFingerprint,
            reason: code,
          }
        : undefined;
    return this.view(
      projectId,
      await this.save(projectId, failed, denied ? { denied, proof: undefined } : {})
    );
  }
  private async settleVerification(
    projectId: string,
    attempt: ProjectBaselineAttempt,
    result: BaselineVerification
  ) {
    const verification = this.cleanVerification(result);
    attempt = { ...attempt, verification };
    if (verification.status !== 'succeeded')
      return await this.fail(
        projectId,
        attempt,
        verification.status === 'failed' ? 'verification-failed' : 'verification-unknown',
        verification.message ?? 'Baseline verification did not complete successfully.',
        true
      );
    if (!attempt.observation?.oid)
      throw new Error('The verification has no pinned baseline commit.');
    return await this.finish(projectId, attempt, 'ready', {
      proof: {
        revision: attempt.revision,
        targetKey: targetKey(attempt.target),
        oid: attempt.observation.oid,
        remoteFingerprint: attempt.observation.remoteFingerprint,
        checkedAt: this.now(),
        verification: 'succeeded',
      },
      denied: undefined,
    });
  }
  private async run(
    projectId: string,
    trigger: ProjectBaselineTrigger
  ): Promise<ProjectBaselineSnapshot> {
    let target: ProjectBaselineTarget;
    try {
      target = projectBaselineTargetSchema.parse(await this.deps.resolve(projectId));
      if (target.projectId !== projectId)
        throw new Error('The baseline target does not belong to this Project.');
    } catch (error) {
      await this.records.runExclusive(projectId, async () => {
        const record = await this.load(projectId);
        await this.write(projectId, {
          ...record,
          resolutionError: {
            revision: record.revision,
            at: this.now(),
            message: redactSecrets(String(error)),
          },
        });
      });
      throw error;
    }
    return this.repositories.runExclusive(target.repositoryKey, async () => {
      let record = await this.load(projectId);
      const previous = record.attempts.at(-1);
      if (
        previous?.phase === 'verifying' &&
        previous.revision === record.revision &&
        trigger !== 'manual'
      ) {
        if (targetKey(previous.target) !== targetKey(target))
          return this.fail(
            projectId,
            previous,
            'verification-unknown',
            'The Project target changed while verification was interrupted.',
            true
          );
        const savedVerification = previous.verification;
        const recovered =
          savedVerification && ['succeeded', 'failed'].includes(savedVerification.status)
            ? savedVerification
            : await this.deps.recoverVerification(previous);
        const settled = await this.settleVerification(projectId, previous, recovered);
        if (!settled.canDelegate) return settled;
        record = await this.load(projectId);
      }
      let attempt: ProjectBaselineAttempt = {
        id: this.deps.id?.() ?? randomUUID(),
        revision: record.revision,
        trigger,
        target,
        startedAt: this.now(),
        phase: 'fetching',
        verificationConfig: record.config.verification,
      };
      await this.save(projectId, attempt, { resolutionError: undefined });
      try {
        await this.deps.authorize(projectId, 'control');
        const observation = projectBaselineObservationSchema.parse(
          await this.deps.synchronize(target)
        );
        attempt = { ...attempt, observation };
        record = await this.save(
          projectId,
          attempt,
          observation.upstreamOid ? { lastContactAt: this.now() } : {}
        );
        if (observation.kind === 'local' && target.remote !== null)
          return await this.fail(
            projectId,
            attempt,
            'invalid-observation',
            'The selected upstream was not checked.'
          );
        if (target.remote !== null && !observation.remoteFingerprint)
          return await this.fail(
            projectId,
            attempt,
            'upstream-identity-unavailable',
            'The upstream identity could not be verified.'
          );
        if (observation.kind === 'blocked')
          return await this.fail(
            projectId,
            attempt,
            observation.reason ?? 'git-blocked',
            observation.message ?? gitBlockerMessage(observation.reason)
          );
        if (!observation.oid)
          return await this.fail(
            projectId,
            attempt,
            'no-baseline',
            'No valid local baseline commit is available.'
          );
        if (observation.kind === 'unavailable') {
          if (observation.reason !== 'network_error')
            return await this.fail(
              projectId,
              attempt,
              observation.reason ?? 'upstream-unavailable',
              observation.message ?? 'The upstream is unavailable.'
            );
          if (record.denied && this.deniedMatches(record, attempt))
            return await this.fail(
              projectId,
              attempt,
              record.denied.reason,
              'Offline access cannot bypass the saved verification failure.'
            );
          if (attempt.verificationConfig && !this.proofMatches(record, attempt))
            return await this.fail(
              projectId,
              attempt,
              'verification-required',
              'This offline baseline has no successful verification for the selected configuration.'
            );
          return await this.finish(projectId, attempt, 'offline');
        }
        if (!attempt.verificationConfig)
          return await this.finish(projectId, attempt, 'ready', {
            proof: {
              revision: attempt.revision,
              targetKey: targetKey(target),
              oid: observation.oid,
              remoteFingerprint: observation.remoteFingerprint,
              checkedAt: this.now(),
              verification: 'not-configured',
            },
            denied: undefined,
          });
        if (this.proofMatches(record, attempt))
          return await this.finish(projectId, attempt, 'ready');
        if (record.denied && this.deniedMatches(record, attempt) && trigger !== 'manual')
          return await this.fail(
            projectId,
            attempt,
            record.denied.reason,
            'Retry baseline verification explicitly before delegating from this commit.'
          );
        attempt = {
          ...attempt,
          phase: 'verifying',
          verification: { status: 'starting', output: '' },
        };
        await this.save(projectId, attempt);
        await this.deps.authorize(projectId, 'control');
        const verification = await this.deps.verify(attempt, async (value) => {
          attempt = { ...attempt, verification: this.cleanVerification(value) };
          await this.save(projectId, attempt);
        });
        return await this.settleVerification(projectId, attempt, verification);
      } catch (error) {
        // A verification may have started on the Host. Preserve its intent/receipt for recovery.
        const persisted = await this.load(projectId);
        const saved = persisted.attempts.find((entry) => entry.id === attempt.id);
        if (saved && saved.revision === persisted.revision)
          await this.save(projectId, {
            ...saved,
            error: { code: 'interrupted', message: redactSecrets(String(error)) },
          });
        throw error;
      }
    });
  }
  async prepareDelegation(projectId: string) {
    const state = await this.synchronize(projectId, 'delegation', { afterCurrent: true });
    const attempt = state.attempts.at(-1);
    if (!state.canDelegate || !attempt?.observation?.oid)
      throw new Error(
        attempt?.error?.message ?? 'The Project baseline is not ready for delegation.'
      );
    return projectBaselineSelectionSchema.parse({
      oid: baselineOidSchema.parse(attempt.observation.oid),
      target: attempt.target,
      checkedAt: state.lastContactAt,
      offline: state.status === 'offline',
      revision: state.revision,
      remoteFingerprint: attempt.observation.remoteFingerprint,
      verification: state.config.verification ? 'succeeded' : 'not-configured',
      verifiedAt: state.config.verification ? (state.proof?.checkedAt ?? null) : null,
    });
  }
}
