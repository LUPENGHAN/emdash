import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { err, ok } from '@emdash/shared';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import { cell } from '@emdash/wire/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAttachmentState } from '../attachments';
import {
  createBackgroundProjectAccess,
  requireAttachedProjectOrThrow,
  withAttachedProject,
} from './attached-project';
import type { ProjectProvider } from './project-provider';

const owners: Scope[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  vi.useRealTimers();
});

function background() {
  const owner = createScope({ label: 'background-project-test' });
  owners.push(owner);
  const state = cell<ProjectAttachmentState>({ kind: 'absent' });
  const provider = { projectId: 'target' } as ProjectProvider;
  const released = vi.fn();
  const track = vi.fn((_id: string, scope: Scope) => {
    scope.add(released);
    return state;
  });
  const requireAttached = vi.fn(() => ok(provider));
  const access = createBackgroundProjectAccess({ track, requireAttached }, owner);
  return { owner, state, provider, released, track, requireAttached, access };
}

describe('background Project access', () => {
  it('waits for attachment without a renderer and retains one lease across callers', async () => {
    const t = background();
    const first = t.access('target');
    const second = t.access('target');
    expect(t.track).toHaveBeenCalledOnce();
    expect(t.requireAttached).not.toHaveBeenCalled();
    t.state.set({ kind: 'attached', establishedHostGeneration: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([t.provider, t.provider]);
    await expect(t.access('target')).resolves.toBe(t.provider);
    expect(t.track).toHaveBeenCalledOnce();
    expect(t.released).not.toHaveBeenCalled();
    await t.owner.dispose();
    expect(t.released).toHaveBeenCalledOnce();
    await expect(t.access('target')).rejects.toThrow();
    expect(t.track).toHaveBeenCalledOnce();
  });

  it('keeps the lease after failure and reads the recovered provider on retry', async () => {
    const t = background();
    t.state.set({ kind: 'absent', lastFailure: { type: 'repository-missing', path: '/repo' } });
    await expect(t.access('target')).rejects.toThrow('repository-missing');
    const recovered = { projectId: 'target', generation: 2 } as unknown as ProjectProvider;
    t.requireAttached.mockReturnValue(ok(recovered));
    t.state.set({ kind: 'attached', establishedHostGeneration: 2 });
    await expect(t.access('target')).resolves.toBe(recovered);
    expect(t.track).toHaveBeenCalledOnce();
  });

  it('rejects suspended Host access instead of waiting on an attached projection', async () => {
    const t = background();
    t.state.set({ kind: 'attached', establishedHostGeneration: 1 });
    const unavailable = createBackgroundProjectAccess(
      {
        track: t.track,
        requireAttached: () =>
          err({
            type: 'host-unavailable',
            host: LOCAL_HOST_REF,
            reason: 'offline',
            message: 'Host is offline.',
          }),
      },
      t.owner
    );
    await expect(unavailable('target')).rejects.toThrow('host-unavailable');
  });

  it('cancels waiting when the application scope closes', async () => {
    const t = background();
    const pending = expect(t.access('target')).rejects.toThrow('attachment was released');
    await t.owner.dispose();
    await pending;
    expect(t.released).toHaveBeenCalledOnce();
  });

  it('bounds an attachment attempt without dropping demand needed by a later retry', async () => {
    vi.useFakeTimers();
    const t = background();
    const pending = expect(t.access('target')).rejects.toThrow('did not attach in time');
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(t.released).not.toHaveBeenCalled();
    t.state.set({ kind: 'attached', establishedHostGeneration: 1 });
    await expect(t.access('target')).resolves.toBe(t.provider);
    expect(t.track).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('attached Project access', () => {
  it('runs fallible work with the attached provider', async () => {
    const project = { projectId: 'project-1' };
    const work = vi.fn(async () => ok('done'));

    await expect(
      withAttachedProject(
        { requireAttached: vi.fn(() => ok(project as never)) },
        project.projectId,
        work
      )
    ).resolves.toEqual(ok('done'));
    expect(work).toHaveBeenCalledWith(project);
  });

  it('returns the attachment error without running work', async () => {
    const attachmentError = { type: 'project-missing' as const, projectId: 'project-1' };
    const work = vi.fn(async () => ok('done'));

    await expect(
      withAttachedProject(
        { requireAttached: vi.fn(() => err(attachmentError)) },
        attachmentError.projectId,
        work
      )
    ).resolves.toEqual(err(attachmentError));
    expect(work).not.toHaveBeenCalled();
  });

  it('throws the attachment type by default and supports boundary-specific errors', () => {
    const attachmentError = { type: 'project-missing' as const, projectId: 'project-1' };
    const projects = { requireAttached: vi.fn(() => err(attachmentError)) };

    expect(() => requireAttachedProjectOrThrow(projects, attachmentError.projectId)).toThrow(
      'project-missing'
    );
    expect(() =>
      requireAttachedProjectOrThrow(
        projects,
        attachmentError.projectId,
        (error) => new Error(`Project attachment unavailable: ${error.type}`)
      )
    ).toThrow('Project attachment unavailable: project-missing');
  });
});
