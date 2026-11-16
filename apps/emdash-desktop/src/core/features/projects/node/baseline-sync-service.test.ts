import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import { deferred } from '@emdash/shared/testing';
import { expect, it, vi } from 'vitest';
import type {
  ProjectBaselineRecord,
  ProjectBaselineTarget,
  BaselineVerification,
  ProjectBaselineObservation,
} from '../api/baseline-sync';
import { ProjectBaselineSyncService, type BaselineSyncDependencies } from './baseline-sync-service';

const firstOid = 'a'.repeat(40);
const nextOid = 'b'.repeat(40);
const fingerprint = 'c'.repeat(64);
function setup() {
  const records = new Map<string, ProjectBaselineRecord>();
  let localOid: string | null = firstOid;
  let clock = 100;
  let ids = 0;
  const target: ProjectBaselineTarget = {
    projectId: 'sdk',
    repositoryKey: 'local:shared-git-dir',
    workspaceId: 'root',
    host: LOCAL_HOST_REF,
    checkout: '/repo',
    baselineRef: localBranchRefSchema.parse('refs/heads/develop'),
    remote: 'upstream',
    upstreamRef: localBranchRefSchema.parse('refs/heads/develop'),
  };
  const observation: ProjectBaselineObservation = {
    kind: 'current',
    beforeOid: firstOid,
    oid: firstOid,
    upstreamOid: firstOid,
    remoteFingerprint: fingerprint,
  };
  const success: BaselineVerification = {
    status: 'succeeded',
    exitCode: 0,
    output: 'Checks passed',
  };
  const deps: BaselineSyncDependencies = {
    store: {
      getOrThrow: async (id) => structuredClone(records.get(id) ?? null),
      setOrThrow: vi.fn(async (id, value) => {
        records.set(id, structuredClone(value));
      }),
    },
    authorize: vi.fn(async () => {}),
    resolve: vi.fn(async (projectId) => ({ ...target, projectId })),
    synchronize: vi.fn(async () => ({ ...observation })),
    readLocal: vi.fn(async () => localOid),
    verify: vi.fn(async () => success),
    recoverVerification: vi.fn(async () => success),
    now: () => clock++,
    id: () => `attempt-${++ids}`,
  };
  const service = () => new ProjectBaselineSyncService(deps);
  const offline = () => {
    vi.mocked(deps.synchronize).mockResolvedValue({
      ...observation,
      kind: 'unavailable',
      upstreamOid: null,
      reason: 'network_error',
    });
  };
  return {
    records,
    target,
    observation,
    success,
    deps,
    service,
    offline,
    local: (oid: string | null) => {
      localOid = oid;
    },
  };
}

it('records Git-only approval without claiming that validation commands ran', async () => {
  const t = setup();
  const service = t.service();
  expect((await service.get('sdk')).status).toBe('not-checked');
  const state = await service.synchronize('sdk', 'attach');
  expect(state).toMatchObject({
    status: 'ready',
    canDelegate: true,
    proof: { oid: firstOid, verification: 'not-configured' },
  });
  expect(state.lastContactAt).not.toBeNull();
  expect(t.deps.verify).not.toHaveBeenCalled();
  expect((await service.prepareDelegation('sdk')).oid).toBe(firstOid);
});

it('verifies the pinned commit and retains bounded redacted evidence', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockImplementation(async (attempt, receipt) => {
    expect(attempt.observation?.oid).toBe(firstOid);
    expect(attempt.verificationConfig?.command).toBe('pnpm test');
    expect(t.records.get('sdk')?.attempts.at(-1)?.phase).toBe('verifying');
    await receipt({
      status: 'running',
      workspaceId: 'check',
      workspacePath: '/checks/attempt',
      runId: 'run-1',
      output: '',
    });
    return {
      ...t.success,
      runId: 'run-1',
      output: 'x'.repeat(20000) + '\nAuthorization: Bearer fixture-secret-token',
    };
  });
  const state = await service.synchronize('sdk', 'manual');
  expect(state.proof?.verification).toBe('succeeded');
  const output = state.attempts.at(-1)?.verification?.output;
  expect(output?.length).toBeLessThanOrEqual(16384);
  expect(output).not.toContain('fixture-secret-token');
  await service.prepareDelegation('sdk');
  expect(t.deps.verify).toHaveBeenCalledOnce();
});

it('does not let a later network error bypass failed verification, including after service recreation', async () => {
  const t = setup();
  await t.service().configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockResolvedValue({
    status: 'failed',
    exitCode: 1,
    output: 'Failed tests',
  });
  expect(await t.service().synchronize('sdk', 'manual')).toMatchObject({
    status: 'blocked',
    canDelegate: false,
    denied: { oid: firstOid },
  });
  t.offline();
  await expect(t.service().prepareDelegation('sdk')).rejects.toThrow('cannot bypass');
  expect(t.deps.verify).toHaveBeenCalledOnce();
});

it('requires explicit retry for the same failed commit but verifies an updated upstream commit', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockResolvedValueOnce({ status: 'failed', exitCode: 1, output: 'Fail' });
  await service.synchronize('sdk', 'manual');
  await expect(service.prepareDelegation('sdk')).rejects.toThrow('explicitly');
  expect(t.deps.verify).toHaveBeenCalledOnce();
  t.local(nextOid);
  vi.mocked(t.deps.synchronize).mockResolvedValue({
    ...t.observation,
    kind: 'updated',
    oid: nextOid,
    upstreamOid: nextOid,
  });
  expect((await service.prepareDelegation('sdk')).oid).toBe(nextOid);
  expect(t.deps.verify).toHaveBeenCalledTimes(2);
});

it('permits explicit manual retry of failed verification and replaces the denial only after success', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockResolvedValueOnce({ status: 'failed', exitCode: 1, output: 'Fail' });
  await service.synchronize('sdk', 'manual');
  const state = await service.synchronize('sdk', 'manual');
  expect(state).toMatchObject({ status: 'ready', canDelegate: true });
  expect(state.denied).toBeUndefined();
});

it('permits an offline local baseline without configured validation and keeps contact time honest', async () => {
  const t = setup();
  t.offline();
  const state = await t.service().synchronize('sdk', 'delegation');
  expect(state).toMatchObject({ status: 'offline', canDelegate: true, lastContactAt: null });
  expect(state.proof).toBeUndefined();
  t.local(null);
  vi.mocked(t.deps.synchronize).mockResolvedValue({
    ...t.observation,
    oid: null,
    upstreamOid: null,
    kind: 'unavailable',
    reason: 'network_error',
  });
  expect((await t.service().synchronize('sdk', 'delegation')).canDelegate).toBe(false);
});

it('permits offline use of an exactly matching verified commit and does not advance its last contact', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  const checked = await service.synchronize('sdk', 'manual');
  t.offline();
  const state = await t.service().synchronize('sdk', 'delegation');
  expect(state).toMatchObject({
    status: 'offline',
    canDelegate: true,
    lastContactAt: checked.lastContactAt,
  });
  expect(t.deps.verify).toHaveBeenCalledOnce();
});

it.each(['auth_failed', 'remote_not_found', 'git_error'])(
  'does not convert %s to offline approval',
  async (reason) => {
    const t = setup();
    vi.mocked(t.deps.synchronize).mockResolvedValue({
      ...t.observation,
      kind: 'unavailable',
      reason,
    });
    expect((await t.service().synchronize('sdk', 'delegation')).canDelegate).toBe(false);
  }
);

it('invalidates offline verification after a configured command or upstream identity changes', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  await service.synchronize('sdk', 'manual');
  t.offline();
  vi.mocked(t.deps.synchronize).mockResolvedValueOnce({
    ...t.observation,
    kind: 'unavailable',
    reason: 'network_error',
    remoteFingerprint: 'd'.repeat(64),
  });
  expect((await service.synchronize('sdk', 'delegation')).canDelegate).toBe(false);
  await service.configure('sdk', 1, { verification: { command: 'pnpm check' } });
  expect((await service.synchronize('sdk', 'delegation')).canDelegate).toBe(false);
});

it('preserves Git blockers instead of promoting an earlier successful proof', async () => {
  const t = setup();
  const service = t.service();
  await service.synchronize('sdk', 'manual');
  vi.mocked(t.deps.synchronize).mockResolvedValue({
    ...t.observation,
    kind: 'blocked',
    reason: 'upstream-rewritten',
  });
  await expect(service.prepareDelegation('sdk')).rejects.toThrow('safely');
  expect((await service.get('sdk')).status).toBe('blocked');
});

it('coalesces concurrent events for one Project and serializes different Projects sharing a repository', async () => {
  const t = setup();
  const gate = deferred<void>();
  let running = 0;
  vi.mocked(t.deps.synchronize).mockImplementation(async () => {
    running++;
    expect(running).toBe(1);
    await gate.promise;
    running--;
    return { ...t.observation };
  });
  const service = t.service();
  const one = service.synchronize('sdk', 'attach');
  const duplicate = service.synchronize('sdk', 'delegation');
  const other = service.synchronize('consumer', 'attach');
  await vi.waitFor(() => expect(t.deps.synchronize).toHaveBeenCalledOnce());
  gate.resolve();
  const states = await Promise.all([one, duplicate, other]);
  expect(states.every((state) => state.canDelegate)).toBe(true);
  expect(t.deps.synchronize).toHaveBeenCalledTimes(2);
  expect(t.records.get('sdk')?.attempts).toHaveLength(1);
});

it('does not overwrite a settings edit with the result of an in-flight verification', async () => {
  const t = setup();
  const gate = deferred<BaselineVerification>();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockImplementation(async () => gate.promise);
  const pending = service.synchronize('sdk', 'manual');
  await vi.waitFor(() => expect(t.deps.verify).toHaveBeenCalledOnce());
  await service.configure('sdk', 1, { verification: { command: 'pnpm check' } });
  const rejected = expect(pending).rejects.toThrow('settings changed');
  gate.resolve(t.success);
  await rejected;
  expect(await service.get('sdk')).toMatchObject({
    revision: 2,
    config: { verification: { command: 'pnpm check' } },
    status: 'needs-check',
    canDelegate: false,
  });
});

it('recovers a saved running receipt without starting verification again', async () => {
  const t = setup();
  await t.service().configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockImplementationOnce(async (_attempt, receipt) => {
    await receipt({ status: 'running', workspaceId: 'check', runId: 'run-1', output: '' });
    throw new Error('Lost completion');
  });
  await expect(t.service().synchronize('sdk', 'manual')).rejects.toThrow('Lost completion');
  const restored = t.service();
  expect((await restored.get('sdk')).status).toBe('interrupted');
  expect((await restored.prepareDelegation('sdk')).oid).toBe(firstOid);
  expect(t.deps.recoverVerification).toHaveBeenCalledWith(
    expect.objectContaining({ verification: expect.objectContaining({ runId: 'run-1' }) })
  );
  expect(t.deps.verify).toHaveBeenCalledOnce();
});

it('keeps unknown delivery blocked after restart without replaying the validation command', async () => {
  const t = setup();
  await t.service().configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockRejectedValueOnce(new Error('Lost start response'));
  await expect(t.service().synchronize('sdk', 'manual')).rejects.toThrow('Lost start response');
  vi.mocked(t.deps.recoverVerification).mockResolvedValue({
    status: 'unknown',
    output: '',
    message: 'Host outcome is unavailable',
  });
  await expect(t.service().prepareDelegation('sdk')).rejects.toThrow('Host outcome');
  t.offline();
  await expect(t.service().prepareDelegation('sdk')).rejects.toThrow('cannot bypass');
  expect(t.deps.verify).toHaveBeenCalledOnce();
});

it('rejects a moved baseline after successful verification', async () => {
  const t = setup();
  await t.service().configure('sdk', 0, { verification: { command: 'pnpm test' } });
  vi.mocked(t.deps.verify).mockImplementation(async () => {
    t.local(nextOid);
    return t.success;
  });
  const state = await t.service().synchronize('sdk', 'manual');
  expect(state).toMatchObject({ canDelegate: false, status: 'blocked' });
  expect(state.attempts.at(-1)?.error?.code).toBe('baseline-moved');
});

it('fails closed on future state versions and stale settings writes', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: null });
  await expect(service.configure('sdk', 0, { verification: null })).rejects.toThrow(
    'settings changed'
  );
  const record = t.records.get('sdk');
  if (!record) throw new Error('Missing fixture state');
  t.records.set('sdk', { ...record, version: '99' } as unknown as ProjectBaselineRecord);
  await expect(service.synchronize('sdk', 'manual')).rejects.toThrow('Cannot read');
  expect(t.deps.synchronize).not.toHaveBeenCalled();
});

it('authorizes each caller before joining background work and before starting verification', async () => {
  const t = setup();
  vi.mocked(t.deps.authorize).mockRejectedValue(new Error('Project is archived'));
  await expect(t.service().synchronize('sdk', 'attach')).rejects.toThrow('archived');
  expect(t.deps.resolve).not.toHaveBeenCalled();
  expect(t.deps.synchronize).not.toHaveBeenCalled();
});

it('persists target resolution failures instead of leaving a previous ready state visible', async () => {
  const t = setup();
  const service = t.service();
  await service.synchronize('sdk', 'attach');
  vi.mocked(t.deps.resolve).mockRejectedValueOnce(new Error('The configured upstream was removed'));
  await expect(service.synchronize('sdk', 'recover')).rejects.toThrow('upstream was removed');
  expect(await t.service().get('sdk')).toMatchObject({
    status: 'failed',
    canDelegate: false,
    resolutionError: { message: expect.stringContaining('upstream was removed') },
  });
  expect((await service.synchronize('sdk', 'manual')).canDelegate).toBe(true);
  expect((await service.get('sdk')).resolutionError).toBeUndefined();
});

it('does not infer verified readiness from a terminal phase whose approval record is missing', async () => {
  const t = setup();
  const service = t.service();
  await service.configure('sdk', 0, { verification: { command: 'pnpm test' } });
  await service.synchronize('sdk', 'manual');
  const record = t.records.get('sdk');
  if (!record) throw new Error('Missing fixture record');
  t.records.set('sdk', { ...record, proof: undefined });
  expect(await t.service().get('sdk')).toMatchObject({ status: 'needs-check', canDelegate: false });
});

it('does not approve offline access when the Host could not establish the upstream identity', async () => {
  const t = setup();
  vi.mocked(t.deps.synchronize).mockResolvedValue({
    ...t.observation,
    kind: 'unavailable',
    reason: 'network_error',
    remoteFingerprint: null,
  });
  expect((await t.service().synchronize('sdk', 'delegation')).canDelegate).toBe(false);
});

it('preserves command whitespace and newlines as opaque shell input', async () => {
  const t = setup();
  const service = t.service();
  const command = "  cat <<'CHECK'\nverify fixture\nCHECK\n";
  await service.configure('sdk', 0, { verification: { command } });
  await service.synchronize('sdk', 'manual');
  expect(vi.mocked(t.deps.verify).mock.calls[0]?.[0].verificationConfig?.command).toBe(command);
  await expect(service.configure('sdk', 1, { verification: { command: ' \n ' } })).rejects.toThrow(
    'must not be empty'
  );
});
