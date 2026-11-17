import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import {
  workspaceRegistryContract,
  type WorkspaceRecord,
} from '@emdash/core/runtimes/workspace-registry/api';
import { ok } from '@emdash/shared';
import { createController, defineContract } from '@emdash/wire/rpc';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeThroughRegistry,
  WorkspaceCreations,
  type RegistryWorktreeSpec,
} from './registry-verbs';

const spec: RegistryWorktreeSpec = {
  host: LOCAL_HOST_REF,
  repositoryWorkspaceId: 'ws-repo',
  repositoryPath: '/repo',
  workspaceId: 'ws-task',
  branch: 'emdash/task',
  baseRef: 'origin/main',
  path: '/worktrees/task',
  preservePatterns: [],
};

function hostRecord(overrides: Partial<WorkspaceRecord> & { id: string }): WorkspaceRecord {
  const at = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    kind: 'worktree',
    path: `/worktrees/${overrides.id}`,
    parentId: null,
    origin: 'registered',
    gitAdminName: null,
    observedStatus: 'present',
    creation: null,
    lastCreateOutcome: null,
    lastRemovalAttempt: null,
    lifecycle: null,
    git: null,
    lastActivatedAt: null,
    createdAt: at,
    updatedAt: at,
    lastObservedAt: at,
    config: null,
    runtime: null,
    ...overrides,
  };
}

/** The registry verbs the creation path calls, served over a real Wire connection. */
const registryVerbsContract = defineContract({
  createWorkspace: workspaceRegistryContract.createWorkspace,
  createWorktree: workspaceRegistryContract.createWorktree,
});

/** A real Wire stack whose `createWorktree` settles only when the test finishes it. */
function createSlowRegistryWire() {
  let started!: () => void;
  const worktreeStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finishWorktree!: () => void;
  const wire = createTestWire(registryVerbsContract, {
    createWorkspace: async (input) =>
      ok(hostRecord({ id: input.workspaceId, kind: 'repository', path: input.path })),
    // `git worktree add` on a large repository.
    createWorktree: (input) =>
      new Promise((resolve) => {
        finishWorktree = () =>
          resolve(ok(hostRecord({ id: input.workspaceId, path: input.path, parentId: 'ws-repo' })));
        started();
      }),
  });
  return {
    wire,
    worktreeStarted,
    finishWorktree: () => finishWorktree(),
    runtimes: { client: async () => ok({ workspaceRegistry: wire.client }) } as never,
  };
}

describe('createWorktreeThroughRegistry', () => {
  let host: ReturnType<typeof createSlowRegistryWire>;

  beforeEach(() => {
    vi.useFakeTimers();
    host = createSlowRegistryWire();
  });

  afterEach(async () => {
    await host.wire.dispose();
    vi.useRealTimers();
  });

  it('waits for a host creation that outlasts the default call deadline', async () => {
    const creations = new WorkspaceCreations();
    let settled = false;
    const outcome = creations
      .run(spec.workspaceId, () => createWorktreeThroughRegistry(host.runtimes, spec))
      .finally(() => {
        settled = true;
      });
    await host.worktreeStarted;

    // The host ignores cancellation and finishes the worktree regardless, so the desktop
    // must not give up first: a client deadline would only misreport a creation in progress.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    expect(creations.pending(spec.workspaceId)).toBeDefined();

    host.finishWorktree();
    await expect(outcome).resolves.toEqual({ success: true, data: undefined });
    expect(creations.pending(spec.workspaceId)).toBeUndefined();
  });

  it('still reports a lost host connection as a transport failure', async () => {
    const creations = new WorkspaceCreations();
    const outcome = creations.run(spec.workspaceId, () =>
      createWorktreeThroughRegistry(host.runtimes, spec)
    );
    await host.worktreeStarted;

    host.wire.pair.disconnect();

    await expect(outcome).resolves.toEqual({
      success: false,
      error: { stage: 'transport', message: 'Wire transport disconnected' },
    });
  });
});

it('uses the management-only host verb without falling back to ordinary worktree creation', async () => {
  const contract = defineContract({
    createWorkspace: workspaceRegistryContract.createWorkspace,
    createManagementWorktree: workspaceRegistryContract.createManagementWorktree,
  });
  const create = vi.fn(async (input: { workspaceId: string; path: string }) =>
    ok(hostRecord({ id: input.workspaceId, path: input.path }))
  );
  const wire = createTestWire(contract, {
    createWorkspace: async (input) =>
      ok(hostRecord({ id: input.workspaceId, path: input.path, kind: 'repository' })),
    createManagementWorktree: create,
  });
  const runtimes = { client: async () => ok({ workspaceRegistry: wire.client }) } as never;
  try {
    expect(
      await createWorktreeThroughRegistry(runtimes, {
        ...spec,
        purpose: 'management',
        baseRef: undefined,
      })
    ).toEqual(ok(undefined));
    expect(create).toHaveBeenCalledWith(
      {
        workspaceId: spec.workspaceId,
        repositoryId: 'ws-repo',
        branch: spec.branch,
        path: spec.path,
      },
      expect.anything()
    );
    expect(
      await createWorktreeThroughRegistry(runtimes, { ...spec, purpose: 'management' })
    ).toMatchObject({ success: false, error: { stage: 'prepare' } });
    expect(create).toHaveBeenCalledOnce();
  } finally {
    await wire.dispose();
  }
});

it('reports an older Host capability over Wire without falling back to a code worktree', async () => {
  const codeCreation = vi.fn(async (input: { workspaceId: string; path: string }) =>
    ok(hostRecord({ id: input.workspaceId, path: input.path }))
  );
  const oldController = createController(registryVerbsContract, {
    createWorkspace: async (input) =>
      ok(
        hostRecord({
          id: input.workspaceId,
          path: input.path,
          kind: 'repository',
        })
      ),
    createWorktree: codeCreation,
  });
  const currentContract = defineContract({
    ...registryVerbsContract,
    createManagementWorktree: workspaceRegistryContract.createManagementWorktree,
  });
  const wire = createTestWire(currentContract, oldController);
  const runtimes = { client: async () => ok({ workspaceRegistry: wire.client }) } as never;
  try {
    const result = await new WorkspaceCreations().run(spec.workspaceId, () =>
      createWorktreeThroughRegistry(runtimes, {
        ...spec,
        purpose: 'management',
        baseRef: undefined,
      })
    );
    expect(result).toMatchObject({
      success: false,
      error: {
        stage: 'capability',
        message: expect.stringContaining('Update the workspace server'),
      },
    });
    expect(codeCreation).not.toHaveBeenCalled();
  } finally {
    await wire.dispose();
  }
});
