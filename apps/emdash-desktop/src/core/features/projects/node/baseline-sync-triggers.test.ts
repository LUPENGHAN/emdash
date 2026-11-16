import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { ok } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { deferred, waitFor } from '@emdash/shared/testing';
import { cell, flushStateTurn } from '@emdash/wire/state';
import { afterEach, expect, it, vi } from 'vitest';
import { HookCore } from '@core/primitives/hooks/api/hookable';
import type { HostAvailabilityState } from '@core/services/hosts/api/availability';
import { projectBaselineSnapshotSchema } from '../api/baseline-sync';
import type { ProjectAttachmentManagerHooks } from '../api/node/project-attachment-manager';
import type { ProjectProvider } from '../api/node/project-provider';
import {
  ProjectBaselineSyncTriggers,
  resolveProjectBaselineMergeTarget,
} from './baseline-sync-triggers';

const scopes: ReturnType<typeof createScope>[] = [];
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
});
const repositoryUrl = 'https://github.com/org/sdk';
const merge = {
  repositoryUrl,
  baseRefName: 'main',
  headRefOid: 'a'.repeat(40),
  url: `${repositoryUrl}/pull/1`,
  observedAt: 100,
};

function setup() {
  const scope = createScope({ label: 'baseline-triggers-test' });
  scopes.push(scope);
  const hooks = new HookCore<ProjectAttachmentManagerHooks>((_name, error) => {
    throw error;
  });
  const state = cell<HostAvailabilityState>({ kind: 'ready', generation: 1 });
  const projects = new Map<string, ProjectProvider>();
  const targets = new Map<string, { repositoryUrl: string; baseRefName: string } | null>();
  const snapshot = projectBaselineSnapshotSchema.parse({
    version: '1',
    revision: 0,
    config: { verification: null },
    attempts: [],
    lastContactAt: null,
    status: 'not-checked',
    canDelegate: false,
  });
  const synchronize = vi.fn<
    ConstructorParameters<typeof ProjectBaselineSyncTriggers>[0]['baselines']['synchronize']
  >(async () => snapshot);
  const onError = vi.fn();
  const mergeTarget = vi.fn(
    async (project: ProjectProvider) => targets.get(project.projectId) ?? null
  );
  const triggers = new ProjectBaselineSyncTriggers({
    scope,
    projects: {
      on: (name, handler) => hooks.on(name, handler),
      requireAttached: (id) => {
        const project = projects.get(id);
        if (!project) throw new Error('Missing fixture Project');
        return ok(project);
      },
    },
    availability: { state: () => state },
    baselines: { synchronize },
    mergeTarget,
    onError,
  });
  const open = async (
    id: string,
    target = { repositoryUrl, baseRefName: 'main' },
    hasRepository = true
  ) => {
    const project = {
      projectId: id,
      hasRepository,
      host: LOCAL_HOST_REF,
    } as unknown as ProjectProvider;
    projects.set(id, project);
    targets.set(id, target);
    await hooks.callHook('projectOpened', id, project);
    return project;
  };
  return {
    scope,
    state,
    projects,
    hooks,
    triggers,
    synchronize,
    onError,
    mergeTarget,
    targets,
    open,
    snapshot,
  };
}

it('checks an attached Git Project once per ready edge and recognizes a recovered Host generation', async () => {
  const t = setup();
  t.state.set({ kind: 'unavailable', recovery: 'waiting' });
  await t.open('sdk');
  expect(t.synchronize).not.toHaveBeenCalled();
  t.state.set({ kind: 'ready', generation: 1 });
  await waitFor(() => t.synchronize.mock.calls.length === 1);
  expect(t.synchronize).toHaveBeenLastCalledWith('sdk', 'attach', { afterCurrent: true });
  t.state.set({ kind: 'ready', generation: 1 });
  flushStateTurn();
  expect(t.synchronize).toHaveBeenCalledOnce();
  t.state.set({ kind: 'unavailable', recovery: 'waiting' });
  flushStateTurn();
  t.state.set({ kind: 'ready', generation: 1 });
  await waitFor(() => t.synchronize.mock.calls.length === 2);
  expect(t.synchronize).toHaveBeenLastCalledWith('sdk', 'recover', { afterCurrent: true });
  t.state.set({ kind: 'ready', generation: 2 });
  await waitFor(() => t.synchronize.mock.calls.length === 3);
});

it('matches the upstream repository and target branch and deduplicates repeated merge facts', async () => {
  const t = setup();
  await t.open('sdk');
  await t.open('release', { repositoryUrl, baseRefName: 'release' });
  await t.open('other', { repositoryUrl: 'https://github.com/org/other', baseRefName: 'main' });
  await waitFor(() => t.synchronize.mock.calls.length === 3);
  t.synchronize.mockClear();
  await t.triggers.merged(merge);
  await waitFor(() => t.synchronize.mock.calls.length === 1);
  expect(t.synchronize).toHaveBeenCalledWith('sdk', 'pr-merged', { afterCurrent: true });
  await t.triggers.merged(merge);
  expect(t.synchronize).toHaveBeenCalledOnce();
});

it('coalesces merge bursts during a running check into a following attempt', async () => {
  const t = setup();
  const gate = deferred<typeof t.snapshot>();
  t.synchronize.mockImplementationOnce(() => gate.promise);
  await t.open('sdk');
  await waitFor(() => t.synchronize.mock.calls.length === 1);
  await Promise.all([
    t.triggers.merged(merge),
    t.triggers.merged({ ...merge, url: `${repositoryUrl}/pull/2` }),
    t.triggers.merged({ ...merge, url: `${repositoryUrl}/pull/3` }),
  ]);
  expect(t.synchronize).toHaveBeenCalledOnce();
  gate.resolve(t.snapshot);
  await waitFor(() => t.synchronize.mock.calls.length === 2);
  expect(t.synchronize).toHaveBeenLastCalledWith('sdk', 'pr-merged', { afterCurrent: true });
});

it('does not retry a failed check without a later event', async () => {
  const t = setup();
  t.synchronize.mockRejectedValueOnce(new Error('Git check failed'));
  await t.open('sdk');
  await waitFor(() => t.onError.mock.calls.length === 1);
  await t.triggers.merged({ ...merge, repositoryUrl: 'https://github.com/unrelated/repo' });
  expect(t.synchronize).toHaveBeenCalledOnce();
  t.triggers.recover();
  await waitFor(() => t.synchronize.mock.calls.length === 2);
});

it('stops observing closed Projects and releases hooks when the owner ends', async () => {
  const t = setup();
  await t.open('sdk');
  await waitFor(() => t.synchronize.mock.calls.length === 1);
  await t.hooks.callHook('projectClosed', 'sdk');
  t.state.set({ kind: 'ready', generation: 2 });
  flushStateTurn();
  await t.triggers.merged(merge);
  t.triggers.recover();
  expect(t.synchronize).toHaveBeenCalledOnce();
  await t.scope.dispose();
  await t.open('another');
  expect(t.synchronize).toHaveBeenCalledOnce();
});

it('skips directory Projects and does not wake an unavailable Host on a PR stream gap', async () => {
  const t = setup();
  await t.open('directory', undefined, false);
  expect(t.synchronize).not.toHaveBeenCalled();
  t.state.set({ kind: 'unavailable', recovery: 'waiting' });
  await t.open('sdk');
  t.triggers.recover();
  expect(t.synchronize).not.toHaveBeenCalled();
});

it('seeds an already attached Project without duplicating its open event', async () => {
  const t = setup();
  const project = await t.open('sdk');
  await waitFor(() => t.synchronize.mock.calls.length === 1);
  t.triggers.projectOpened('sdk', project);
  expect(t.synchronize).toHaveBeenCalledOnce();
});

it('resolves a branch-specific upstream before the project base remote', async () => {
  const repositoryUrls = vi.fn(async () => [repositoryUrl]);
  const project = {
    projectId: 'sdk',
    settings: {
      getStoredGitSettings: async () => ({
        defaultBranch: { remote: 'organization', branch: 'main' },
        baseRemote: 'personal',
      }),
      getPlacementContext: async () => ({
        builtInWorktreeRoot: '/checks',
        homeDirectory: '/home/test',
      }),
    },
    repoFacts: {
      get: async () => ({
        localBranches: ['main'],
        remotes: [
          {
            name: 'personal',
            url: 'git@github.com:me/sdk.git',
            branches: ['main'],
            headBranch: 'main',
            host: 'github.com',
          },
          {
            name: 'organization',
            url: 'git@github.com:org/sdk.git',
            branches: ['main'],
            headBranch: 'main',
            host: 'github.com',
          },
        ],
      }),
    },
    git: {
      repository: {
        model: {
          state: () => ({
            snapshot: async () => ({
              data: {
                remotes: [
                  { name: 'personal', url: 'git@github.com:me/sdk.git' },
                  { name: 'organization', url: 'git@github.com:org/sdk.git' },
                ],
              },
            }),
          }),
        },
      },
    },
    repository: {},
  } as unknown as ProjectProvider;
  expect(await resolveProjectBaselineMergeTarget(project, repositoryUrls)).toEqual({
    repositoryUrl,
    baseRefName: 'main',
  });
  expect(repositoryUrls).toHaveBeenCalledWith('git@github.com:org/sdk.git');
});
