import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { ScriptRunState } from '@emdash/core/runtimes/scripts/api';
import type { WorkspaceRecord } from '@emdash/core/runtimes/workspace-registry/api';
import { ok } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { afterEach, expect, it, vi } from 'vitest';
import { nativePathFromHost } from '@core/primitives/desktop-runtime/api';
import { projectBaselineAttemptSchema, type BaselineVerification } from '../api/baseline-sync';
import { createBaselineVerification } from './baseline-verification';

const scopes: ReturnType<typeof createScope>[] = [];
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
});
const oid = 'a'.repeat(40);

function setup(pool = '/checks/sdk') {
  const scope = createScope({ label: 'baseline-verification-test' });
  scopes.push(scope);
  const attempt = projectBaselineAttemptSchema.parse({
    id: 'attempt-1',
    revision: 3,
    trigger: 'manual',
    target: {
      projectId: 'sdk',
      repositoryKey: 'repo',
      workspaceId: 'root',
      host: LOCAL_HOST_REF,
      checkout: '/repo',
      baselineRef: 'refs/heads/develop',
      remote: null,
      upstreamRef: null,
    },
    startedAt: 1,
    phase: 'verifying',
    observation: { kind: 'local', beforeOid: oid, oid, upstreamOid: null, remoteFingerprint: null },
    verificationConfig: { command: 'printf "verified\\n"\n', timeoutMs: 10000 },
  });
  const records: Record<string, WorkspaceRecord> = {};
  const receipts: BaselineVerification[] = [];
  let head = oid;
  let current: ScriptRunState = {
    runId: 'run-1',
    script: 'prepare',
    provenance: 'manual',
    status: 'succeeded',
    startedAt: 10,
    finishedAt: 20,
    exitCode: 0,
    outputTail: 'verified\n',
  };
  const create = vi.fn(
    async (input: {
      workspaceId: string;
      repositoryId: string;
      path: string;
      branch: string;
      baseRef: string;
    }) => {
      expect(receipts[0]).toMatchObject({ status: 'starting', workspaceId: input.workspaceId });
      const record: WorkspaceRecord = {
        id: input.workspaceId,
        kind: 'worktree',
        parentId: input.repositoryId,
        path: input.path,
        origin: 'registered',
        gitAdminName: 'check',
        observedStatus: 'present',
        creation: { branch: input.branch, baseRef: input.baseRef, requestedPath: input.path },
        lastCreateOutcome: { status: 'succeeded', at: 1 },
        lifecycle: null,
        lastRemovalAttempt: null,
        git: null,
        lastActivatedAt: null,
        createdAt: 1,
        updatedAt: 1,
        lastObservedAt: 1,
        config: null,
        runtime: null,
      };
      records[record.id] = record;
      return ok(record);
    }
  );
  const readHead = vi.fn(async (_input: { checkout: Parameters<typeof nativePathFromHost>[0] }) =>
    ok({ kind: 'detached', shortHash: head.slice(0, 7), oid: head })
  );
  const config = vi.fn(async () =>
    ok({
      resolved: {
        shellSetup: { value: 'export CHECK_SETUP=1' },
        env: { value: { CHECK_ENV: 'yes' } },
      },
    })
  );
  const start = vi.fn(async () => ok({ ...current, status: 'running', exitCode: undefined }));
  const wait = vi.fn(async () => ok(current));
  const save = vi.fn(async (value: BaselineVerification) => {
    receipts.push(structuredClone(value));
  });
  // These test handles implement the procedures exercised by the executor only.
  const host = {
    pool,
    registry: {
      createWorktree: create,
      getProjectConfig: config,
      records: { state: () => ({ snapshot: async () => ({ data: records }) }) },
    },
    git: { readHead },
    scripts: {
      start,
      wait,
      runs: { state: () => ({ snapshot: async () => ({ data: { prepare: current } }) }) },
    },
  } as unknown as Awaited<ReturnType<Parameters<typeof createBaselineVerification>[0]['resolve']>>;
  const executor = () => createBaselineVerification({ scope, resolve: async () => host });
  const savedAttempt = () => ({ ...attempt, verification: receipts.at(-1) });
  return {
    attempt,
    executor,
    save,
    receipts,
    records,
    create,
    start,
    wait,
    config,
    readHead,
    savedAttempt,
    setHead: (value: string) => {
      head = value;
    },
    setRun: (value: Partial<ScriptRunState>) => {
      current = { ...current, ...value };
    },
  };
}

it('checks the pinned checkout and saves artifact and run receipts before waiting', async () => {
  const t = setup();
  const result = await t.executor().verify(t.attempt, t.save);
  expect(result).toMatchObject({
    status: 'succeeded',
    exitCode: 0,
    output: 'verified\n',
    runId: 'run-1',
  });
  expect(t.receipts.map((value) => value.status)).toEqual(['starting', 'running']);
  expect(t.create.mock.calls[0]?.[0]).toMatchObject({ baseRef: oid, preservePatterns: [] });
  expect(t.start).toHaveBeenCalledWith(
    expect.objectContaining({
      workspacePath: t.receipts[0]?.workspacePath,
      command: t.attempt.verificationConfig?.command,
      timeoutMs: 10000,
      shellSetup: 'export CHECK_SETUP=1',
      env: { CHECK_ENV: 'yes' },
    }),
    expect.objectContaining({ timeoutMs: 0 })
  );
  expect(t.wait).toHaveBeenCalledWith(
    expect.objectContaining({ runId: 'run-1' }),
    expect.anything()
  );
  expect(t.readHead).toHaveBeenCalledTimes(2);
  const checked = t.readHead.mock.calls[0]?.[0];
  if (!checked) throw new Error('The checkout was not inspected');
  expect(nativePathFromHost(checked.checkout)).toBe(t.receipts[0]?.workspacePath);
});

it('never starts when persisting the initial workspace intent fails', async () => {
  const t = setup();
  t.save.mockRejectedValueOnce(new Error('Disk unavailable'));
  await expect(t.executor().verify(t.attempt, t.save)).rejects.toThrow('Disk unavailable');
  expect(t.create).not.toHaveBeenCalled();
  expect(t.start).not.toHaveBeenCalled();
});

it('refuses to execute a checkout that does not contain the approved commit', async () => {
  const t = setup();
  t.setHead('b'.repeat(40));
  await expect(t.executor().verify(t.attempt, t.save)).rejects.toThrow('pinned baseline');
  expect(t.start).not.toHaveBeenCalled();
});

it('rejects a successful command if it moved the checkout to another commit', async () => {
  const t = setup();
  t.wait.mockImplementationOnce(async () => {
    t.setHead('b'.repeat(40));
    return ok({
      runId: 'run-1',
      script: 'prepare',
      provenance: 'manual',
      status: 'succeeded',
      startedAt: 1,
      exitCode: 0,
      outputTail: 'wrong checkout',
    });
  });
  await expect(t.executor().verify(t.attempt, t.save)).rejects.toThrow('pinned baseline');
});

it.each(['failed', 'timed-out', 'cancelled'] as const)(
  'retains a %s command as failed validation',
  async (status) => {
    const t = setup();
    t.setRun({ status, exitCode: status === 'failed' ? 7 : null, outputTail: 'failure detail' });
    expect(await t.executor().verify(t.attempt, t.save)).toMatchObject({
      status: 'failed',
      output: 'failure detail',
    });
  }
);

it('recovers the exact settled Host run after losing the desktop wait response', async () => {
  const t = setup();
  t.wait.mockRejectedValueOnce(new Error('Connection lost'));
  await expect(t.executor().verify(t.attempt, t.save)).rejects.toThrow('Connection lost');
  expect(await t.executor().recoverVerification(t.savedAttempt())).toMatchObject({
    status: 'succeeded',
    runId: 'run-1',
  });
  expect(t.create).toHaveBeenCalledOnce();
  expect(t.start).toHaveBeenCalledOnce();
});

it('waits for the original running run on recovery without starting it again', async () => {
  const t = setup();
  await t.executor().verify(t.attempt, t.save);
  t.setRun({ status: 'running', exitCode: undefined });
  t.wait.mockResolvedValueOnce(
    ok({
      runId: 'run-1',
      script: 'prepare',
      provenance: 'manual',
      status: 'succeeded',
      startedAt: 1,
      exitCode: 0,
      outputTail: 'finished',
    })
  );
  expect(await t.executor().recoverVerification(t.savedAttempt())).toMatchObject({
    status: 'succeeded',
    output: 'finished',
  });
  expect(t.start).toHaveBeenCalledOnce();
});

it('does not adopt another run after the Host loses its in-memory execution record', async () => {
  const t = setup();
  await t.executor().verify(t.attempt, t.save);
  t.setRun({ runId: 'unrelated-run' });
  expect(await t.executor().recoverVerification(t.savedAttempt())).toMatchObject({
    status: 'unknown',
  });
  expect(t.start).toHaveBeenCalledOnce();
});

it('does not replay a command when its start response was lost', async () => {
  const t = setup();
  t.start.mockRejectedValueOnce(new Error('Start response lost'));
  await expect(t.executor().verify(t.attempt, t.save)).rejects.toThrow('Start response lost');
  expect(await t.executor().recoverVerification(t.savedAttempt())).toMatchObject({
    status: 'unknown',
  });
  expect(t.wait).not.toHaveBeenCalled();
  expect(t.start).toHaveBeenCalledOnce();
});

it('refuses recovery after the workspace record has been replaced', async () => {
  const t = setup();
  await t.executor().verify(t.attempt, t.save);
  const record = Object.values(t.records)[0];
  if (!record) throw new Error('Missing fixture workspace');
  record.parentId = 'other-repository';
  expect(await t.executor().recoverVerification(t.savedAttempt())).toMatchObject({
    status: 'unknown',
  });
  expect(t.start).toHaveBeenCalledOnce();
});

it('places checks using the Host path dialect, including a remote Windows pool', async () => {
  const t = setup('D:\\worktrees\\sdk');
  await t.executor().verify(t.attempt, t.save);
  expect(t.receipts[0]?.workspacePath).toMatch(/^D:\\worktrees\\sdk\\baseline-check-[a-f0-9]{64}$/);
});
