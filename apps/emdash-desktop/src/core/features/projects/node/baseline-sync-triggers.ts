import type { Scope } from '@emdash/shared/concurrency';
import { observe } from '@emdash/wire/state';
import type { HostAvailability } from '@core/services/hosts/api/availability';
import type { PullRequestMergedObservation } from '@core/services/pull-requests/api/schemas';
import type { ProjectBaselineTrigger } from '../api/baseline-sync';
import type { ProjectAttachmentManager } from '../api/node/project-attachment-manager';
import type { ProjectProvider } from '../api/node/project-provider';
import { resolveProjectEffectiveSettings } from '../api/node/settings/effective-settings';
import type { ProjectBaselineSyncService } from './baseline-sync-service';

type AutomaticTrigger = Extract<ProjectBaselineTrigger, 'attach' | 'recover' | 'pr-merged'>;
type Entry = {
  scope: Scope;
  provider: ProjectProvider;
  wasReady: boolean;
  generation?: number;
  pending?: AutomaticTrigger;
  running?: Promise<void>;
  merges: Set<string>;
};
type Dependencies = {
  scope: Scope;
  projects: Pick<ProjectAttachmentManager, 'on' | 'requireAttached'>;
  availability: Pick<HostAvailability, 'state'>;
  baselines: Pick<ProjectBaselineSyncService, 'synchronize'>;
  mergeTarget(
    project: ProjectProvider
  ): Promise<{ repositoryUrl: string; baseRefName: string } | null>;
  onError(projectId: string | undefined, error: unknown): void;
};

/** Event-driven checks; only explicit observations can schedule another attempt after a failure. */
export class ProjectBaselineSyncTriggers {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly deps: Dependencies) {
    deps.scope.add(
      deps.projects.on('projectOpened', (id, project) => this.projectOpened(id, project))
    );
    deps.scope.add(deps.projects.on('projectClosed', (id) => this.close(id)));
    deps.scope.add(() => this.entries.clear());
  }

  projectOpened(projectId: string, provider: ProjectProvider): void {
    if (this.deps.scope.disposed) return;
    const previous = this.entries.get(projectId);
    if (previous?.provider === provider) return;
    if (previous) void previous.scope.dispose();
    this.entries.delete(projectId);
    if (!provider.hasRepository) return;
    const entry: Entry = {
      scope: this.deps.scope.child(`baseline-events:${projectId}`),
      provider,
      wasReady: false,
      generation: previous?.generation,
      merges: new Set(),
    };
    this.entries.set(projectId, entry);
    observe(
      this.deps.availability.state(provider.host),
      ({ value }) => {
        if (value.kind !== 'ready') {
          entry.wasReady = false;
          return;
        }
        if (entry.wasReady && entry.generation === value.generation) return;
        const trigger = entry.generation === undefined ? 'attach' : 'recover';
        entry.generation = value.generation;
        entry.wasReady = true;
        this.schedule(projectId, entry, trigger);
      },
      { scope: entry.scope, immediate: true }
    );
  }

  private async close(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    this.entries.delete(projectId);
    await entry?.scope.dispose();
  }

  private schedule(projectId: string, entry: Entry, trigger: AutomaticTrigger): void {
    if (entry.scope.disposed || this.entries.get(projectId) !== entry) return;
    const rank = { attach: 0, recover: 1, 'pr-merged': 2 };
    if (!entry.pending || rank[trigger] > rank[entry.pending]) entry.pending = trigger;
    if (entry.running) return;
    entry.running = (async () => {
      while (entry.pending && !entry.scope.disposed && this.entries.get(projectId) === entry) {
        const next = entry.pending;
        entry.pending = undefined;
        try {
          await this.deps.baselines.synchronize(projectId, next, { afterCurrent: true });
        } catch (error) {
          if (!entry.scope.disposed) this.deps.onError(projectId, error);
        }
      }
    })().finally(() => {
      entry.running = undefined;
      if (entry.pending) this.schedule(projectId, entry, entry.pending);
    });
  }

  async merged(observation: PullRequestMergedObservation): Promise<void> {
    await Promise.all(
      [...this.entries].map(async ([projectId, entry]) => {
        try {
          const attached = this.deps.projects.requireAttached(projectId);
          if (!attached.success || attached.data !== entry.provider) return;
          const target = await this.deps.mergeTarget(attached.data);
          const key = JSON.stringify([
            observation.repositoryUrl,
            observation.url,
            observation.headRefOid,
          ]);
          if (
            target?.repositoryUrl === observation.repositoryUrl &&
            target.baseRefName === observation.baseRefName &&
            !entry.merges.has(key)
          ) {
            entry.merges.add(key);
            this.schedule(projectId, entry, 'pr-merged');
          }
        } catch (error) {
          if (!entry.scope.disposed) this.deps.onError(projectId, error);
        }
      })
    );
  }

  recover(): void {
    for (const [id, entry] of this.entries) {
      if (entry.wasReady && this.deps.projects.requireAttached(id).success)
        this.schedule(id, entry, 'recover');
    }
  }
}

export async function resolveProjectBaselineMergeTarget(
  project: ProjectProvider,
  repositoryUrls: (url: string) => Promise<string[]>
) {
  const effective = await resolveProjectEffectiveSettings({
    settings: project.settings,
    repoFacts: project.repoFacts,
    projectId: project.projectId,
  });
  if (effective.defaultBranch.provenance.kind === 'broken-setting')
    throw new Error('The configured code baseline is unavailable.');
  const branch = effective.defaultBranch.value;
  if (!branch) return null;
  if (branch.remote === null && effective.baseRemote.provenance.kind === 'broken-setting')
    throw new Error('The configured upstream is unavailable.');
  const remote = branch.remote ?? effective.baseRemote.value;
  if (!remote) return null;
  const remotes = (
    await project.git.repository.model.state(project.repository, 'remotes').snapshot()
  ).data.remotes;
  const source = remotes.find((entry) => entry.name === remote);
  if (!source) throw new Error('The configured upstream remote is unavailable.');
  const urls = await repositoryUrls(source.url);
  return urls.length === 1 ? { repositoryUrl: urls[0], baseRefName: branch.branch } : null;
}
