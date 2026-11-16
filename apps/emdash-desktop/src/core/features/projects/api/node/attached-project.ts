import type { DataOf, ErrorOf, Result } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { observe, type Readable } from '@emdash/wire/state';
import type { ProjectAttachmentError } from '@core/features/projects/api';
import type { ProjectAttachmentState } from '@core/features/projects/api/attachments';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectProvider } from '@core/features/projects/api/node/project-provider';

export type ProjectAttachmentAccess = Pick<ProjectAttachmentManager, 'requireAttached'>;

/** Retains background demand without depending on a renderer's Project subscription. */
export function createBackgroundProjectAccess(
  projects: Pick<ProjectAttachmentManager, 'requireAttached' | 'track'>,
  owner: Scope
): (projectId: string) => Promise<ProjectProvider> {
  const leases = new Map<string, { scope: Scope; state: Readable<ProjectAttachmentState> }>();
  owner.add(() => leases.clear());
  return async (projectId) => {
    owner.signal.throwIfAborted();
    let held = leases.get(projectId);
    if (!held) {
      const scope = owner.child(`background-project:${projectId}`);
      held = { scope, state: projects.track(projectId, scope) };
      leases.set(projectId, held);
    }
    const lease = held;
    const wait = lease.scope.child('await-attachment');
    try {
      return await new Promise<ProjectProvider>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('The target project did not attach in time.')),
          30000
        );
        wait.add(() => {
          clearTimeout(timeout);
          reject(new Error('Project attachment was released.'));
        });
        observe(
          lease.state,
          ({ value }) => {
            if (value.kind === 'attached') {
              const attached = projects.requireAttached(projectId);
              if (attached.success) resolve(attached.data);
              else reject(new Error(`The target project is unavailable: ${attached.error.type}`));
            } else if (value.kind === 'absent' && value.lastFailure) {
              reject(new Error(`The target project is unavailable: ${value.lastFailure.type}`));
            }
          },
          { scope: wait, immediate: true }
        );
      });
    } finally {
      await wait.dispose();
    }
  };
}

export async function withAttachedProject<R extends Result<unknown, unknown>>(
  projects: ProjectAttachmentAccess,
  projectId: string,
  work: (project: ProjectProvider) => R | Promise<R>
): Promise<Result<DataOf<R>, ErrorOf<R> | ProjectAttachmentError>> {
  const attached = projects.requireAttached(projectId);
  if (!attached.success) return attached;
  return (await work(attached.data)) as Result<DataOf<R>, ErrorOf<R>>;
}

export function requireAttachedProjectOrThrow(
  projects: ProjectAttachmentAccess,
  projectId: string,
  toError: (error: ProjectAttachmentError) => Error = (error) => new Error(error.type)
): ProjectProvider {
  const attached = projects.requireAttached(projectId);
  if (!attached.success) throw toError(attached.error);
  return attached.data;
}
