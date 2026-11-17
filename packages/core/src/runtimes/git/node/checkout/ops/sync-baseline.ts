import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { err, ok, type Result } from '@emdash/shared';
import { gitErr, type CheckoutHeadState } from '#runtimes/git/api';
import {
  syncBaselineJobInputSchema,
  type SyncBaselineJobInput,
  type BaselineSyncResult,
  type BaselineSyncError,
  type BaselineSyncObservation,
} from '#runtimes/git/api/checkout/baseline-sync';
import type { CheckoutIdentity } from '#runtimes/git/node/allocation/identity';
import { gitFailure } from '#runtimes/git/node/exec/errors';
import type { GitOperationContext } from '#runtimes/git/node/exec/operation-context';
import { execGitWithProgress } from '#runtimes/git/node/exec/transfer-progress';
import { repositoryFailures } from '#runtimes/git/node/repository/errors';
import type { BoundExec } from '#services/exec/api';
import { computeHeadState } from './head';
import { computeStatusState } from './status';

type Input = Omit<SyncBaselineJobInput, 'checkout' | 'credentials'>;
type BlockedReason = Extract<BaselineSyncResult, { kind: 'blocked' }>['reason'];

/** Runs under the repository family lane and object-transfer lock. */
export async function syncBaseline(
  exec: BoundExec,
  identity: CheckoutIdentity,
  raw: Input,
  context: GitOperationContext
): Promise<Result<BaselineSyncResult, BaselineSyncError>> {
  const input = syncBaselineJobInputSchema.omit({ checkout: true, credentials: true }).parse(raw);
  const run = (args: string[]) => exec.exec(args, { signal: context.signal });
  const readOid = async (ref: string): Promise<string | null> => {
    try {
      return (await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim();
    } catch (error) {
      context.signal?.throwIfAborted();
      if (gitFailure(error).exitCode === 1) return null;
      throw error;
    }
  };
  const symbolic = async (ref: string): Promise<boolean> => {
    try {
      await run(['symbolic-ref', '-q', ref]);
      return true;
    } catch (error) {
      context.signal?.throwIfAborted();
      if (gitFailure(error).exitCode === 1) return false;
      throw error;
    }
  };
  const ancestor = async (from: string, to: string): Promise<boolean> => {
    try {
      await run(['merge-base', '--is-ancestor', from, to]);
      return true;
    } catch (error) {
      context.signal?.throwIfAborted();
      if (gitFailure(error).exitCode === 1) return false;
      throw error;
    }
  };
  const remoteUrl = async () => {
    const { stdout } = await run(['remote', 'get-url', '--all', '--', input.remote]);
    const urls = stdout.replace(/\n$/, '').split('\n');
    return urls.length === 1 && urls[0] ? urls[0] : undefined;
  };
  const refExists = async (ref: string) =>
    (await run(['for-each-ref', '--format=%(refname)', '--', ref])).stdout
      .split('\n')
      .includes(ref);
  let diagnostic: BaselineSyncObservation | undefined;
  try {
    const url = await remoteUrl();
    if (!url) return gitErr.commandFailed('Choose an upstream remote with exactly one fetch URL.');
    const fingerprint = createHash('sha256').update(url).digest('hex');
    const checkpointKey = createHash('sha256')
      .update(JSON.stringify([fingerprint, input.upstreamRef]))
      .digest('hex');
    const checkpoint = `refs/emdash/baseline-observations/${checkpointKey}`;
    const observation = {
      remote: input.remote,
      remoteFingerprint: fingerprint,
      upstreamRef: input.upstreamRef,
      baselineRef: input.baselineRef,
      beforeOid: await readOid(input.baselineRef),
      afterOid: null as string | null,
      upstreamOid: null as string | null,
      previousUpstreamOid: null as string | null,
    };
    observation.afterOid = observation.beforeOid;
    diagnostic = observation;
    const blocked = async (reason: BlockedReason) =>
      ok({
        ...observation,
        afterOid: await readOid(input.baselineRef),
        kind: 'blocked' as const,
        reason,
      });
    if (
      [input.baselineRef, input.upstreamRef].some((ref) =>
        ref.startsWith('refs/heads/emdash/manage/')
      )
    )
      return await blocked('management-branch');
    if (input.expectedRemoteFingerprint && input.expectedRemoteFingerprint !== fingerprint)
      return await blocked('remote-changed');
    if (await symbolic(input.baselineRef)) return await blocked('symbolic-baseline');
    if (!observation.beforeOid && (await refExists(input.baselineRef)))
      return await blocked('history-unavailable');
    if (await symbolic(checkpoint)) return await blocked('symbolic-checkpoint');
    observation.previousUpstreamOid = await readOid(checkpoint);
    if (!observation.previousUpstreamOid && (await refExists(checkpoint)))
      return await blocked('history-unavailable');
    // Resolve exactly the configured upstream, then fetch its immutable object without
    // a destination ref. A killed Host cannot leave a temporary ref for another instance
    // to misclassify as abandoned. Configured refspecs and FETCH_HEAD remain untouched.
    const advertised = await exec.exec(
      ['ls-remote', '--refs', '--', input.remote, input.upstreamRef],
      { signal: context.signal, env: context.env }
    );
    const matches = advertised.stdout
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter((fields) => fields[1] === input.upstreamRef);
    const target = matches.length === 1 && matches[0].length === 2 ? matches[0][0] : undefined;
    if (!target || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(target))
      return await blocked('history-unavailable');
    if ((await remoteUrl()) !== url) return await blocked('remote-changed');
    await execGitWithProgress(
      exec,
      [
        'fetch',
        '--progress',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        '--no-recurse-submodules',
        '--refmap=',
        '--',
        input.remote,
        target,
      ],
      context
    );
    if ((await readOid(target)) !== target) return await blocked('history-unavailable');
    observation.upstreamOid = target;
    const prior = observation.previousUpstreamOid;
    if (prior && !(await ancestor(prior, target))) return await blocked('upstream-rewritten');
    if ((await remoteUrl()) !== url) return await blocked('remote-changed');
    await run(['update-ref', '--no-deref', checkpoint, target, prior ?? '0'.repeat(target.length)]);

    const initialHead = await computeHeadState(exec);
    const root = await realpath(identity.checkoutRoot);
    const { stdout: worktrees } = await run(['worktree', 'list', '--porcelain', '-z']);
    for (const entry of worktrees.split('\0\0')) {
      const fields = entry.split('\0');
      if (!fields.includes(`branch ${input.baselineRef}`)) continue;
      const directory = fields.find((field) => field.startsWith('worktree '))?.slice(9);
      if (!directory) return await blocked('checked-out-elsewhere');
      try {
        if ((await realpath(directory)) !== root) return await blocked('checked-out-elsewhere');
      } catch {
        return await blocked('checked-out-elsewhere');
      }
    }
    const ready = async (): Promise<BlockedReason | null> => {
      const status = await computeStatusState(exec, identity.gitDir);
      if (status.kind !== 'ok') return 'checkout-unavailable';
      if (status.operation !== 'none') return 'checkout-busy';
      if (Object.keys(status.entries).length) return 'checkout-dirty';
      if (await symbolic(input.baselineRef)) return 'symbolic-baseline';
      if ((await readOid(input.baselineRef)) !== observation.beforeOid) return 'local-changed';
      if (!sameHead(await computeHeadState(exec), initialHead)) return 'local-changed';
      return null;
    };
    let reason = await ready();
    if (reason) return await blocked(reason);
    const before = observation.beforeOid;
    if (before && !(await ancestor(before, target)))
      return await blocked((await ancestor(target, before)) ? 'local-ahead' : 'diverged');
    if (before === target)
      return ok({ ...observation, kind: 'current', upstreamOid: target, afterOid: target });
    if ((await remoteUrl()) !== url) return await blocked('remote-changed');
    reason = await ready();
    if (reason) return await blocked(reason);
    if (initialHead.kind !== 'detached' && initialHead.ref === input.baselineRef) {
      // Git owns the checked-out baseline's index and worktree update. Never move that
      // ref directly, and never stash local work to make a fast-forward possible.
      await run([
        '-c',
        'merge.autostash=false',
        '-c',
        'submodule.recurse=false',
        'merge',
        '--ff-only',
        '--no-overwrite-ignore',
        '--no-edit',
        '--no-stat',
        '--',
        target,
      ]);
    } else {
      // Git's non-forcing fetch refuses checked-out destinations and non-fast-forwards
      // even if another checkout or branch update raced the preceding observations.
      await execGitWithProgress(
        exec,
        [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-auto-maintenance',
          '--no-recurse-submodules',
          '--refmap=',
          '--',
          identity.gitCommonDir,
          `${target}:${input.baselineRef}`,
        ],
        context
      );
    }
    observation.afterOid = await readOid(input.baselineRef);
    if (observation.afterOid !== target) return await blocked('local-changed');
    return ok({ ...observation, kind: 'updated', upstreamOid: target, afterOid: target });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    const failure = repositoryFailures.fetch(error, input.remote);
    if (!diagnostic) return failure;
    return err({
      ...failure.error,
      observation: { ...diagnostic, afterOid: await readOid(input.baselineRef) },
    });
  }
}

function sameHead(left: CheckoutHeadState, right: CheckoutHeadState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'detached' && right.kind === 'detached') return left.oid === right.oid;
  if (left.kind === 'unborn' && right.kind === 'unborn') return left.ref === right.ref;
  return (
    left.kind === 'branch' &&
    right.kind === 'branch' &&
    left.ref === right.ref &&
    left.oid === right.oid
  );
}
