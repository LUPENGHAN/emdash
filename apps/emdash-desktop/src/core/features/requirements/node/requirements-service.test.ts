import { describe, expect, it, vi } from 'vitest';
import type { ProjectRequirements, RequirementsEvent } from '../api/types';
import { REQUIREMENTS_PER_PROJECT_MAX } from '../api/types';
import { RequirementsService, type RequirementsStore } from './requirements-service';

function setup(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const store: RequirementsStore = {
    getOrThrow: vi.fn(async (projectId: string) => structuredClone(data.get(projectId) ?? null)),
    setOrThrow: vi.fn(async (projectId: string, value: ProjectRequirements) => {
      data.set(projectId, structuredClone(value));
    }),
    del: vi.fn(async (projectId: string) => {
      data.delete(projectId);
    }),
  };
  const events: RequirementsEvent[] = [];
  let clock = 1000;
  let ids = 0;
  const service = new RequirementsService({
    store,
    emit: (event) => events.push(event),
    now: () => clock++,
    newId: () => `r${++ids}`,
  });
  return { service, store, data, events };
}

const user = { kind: 'user' } as const;
const agent = {
  kind: 'agent',
  providerId: 'claude',
  conversationId: 'conv-1',
  taskId: 'task-1',
} as const;

describe('RequirementsService', () => {
  it('lists open ones first, each newest first', async () => {
    const { service } = setup();
    await service.add('p', { title: 'one' }, user);
    await service.add('p', { title: 'two' }, user);
    await service.add('p', { title: 'three' }, user);
    await service.update('p', 'r3', { status: 'done' });
    await service.update('p', 'r1', { status: 'done' });
    expect((await service.list('p')).map((item) => item.title)).toEqual(['two', 'three', 'one']);
  });

  it('trims input and stores the detail only when there is one', async () => {
    const { service } = setup();
    const item = await service.add('p', { title: '  Fix it  ', detail: '   ' }, user);
    expect(item).toMatchObject({ title: 'Fix it', status: 'open', source: user });
    expect(item).not.toHaveProperty('detail');
  });

  it('updates the status and clears the detail', async () => {
    const { service } = setup();
    await service.add('p', { title: 'Fix it', detail: 'in the parser' }, user);
    const done = await service.update('p', 'r1', { status: 'done', detail: '' });
    expect(done.status).toBe('done');
    expect(done).not.toHaveProperty('detail');
    expect(done.updatedAt).toBeGreaterThan(done.createdAt);
    await expect(service.update('p', 'missing', { status: 'done' })).rejects.toThrow(
      'No requirement missing in this project'
    );
  });

  it('removes one, and ignores an id that is not there', async () => {
    const { service } = setup();
    await service.add('p', { title: 'one' }, user);
    await service.remove('p', 'missing');
    await service.remove('p', 'r1');
    expect(await service.list('p')).toEqual([]);
  });

  it('refuses unreadable data and leaves it as it was', async () => {
    const broken = { version: 1, items: [{ id: 'x', title: '' }] };
    const { service, data } = setup({ p: broken });
    await expect(service.list('p')).rejects.toThrow(
      'Requirements for this project could not be read'
    );
    await expect(service.add('p', { title: 'new' }, user)).rejects.toThrow(
      'Requirements for this project could not be read'
    );
    expect(data.get('p')).toEqual(broken);
  });

  it('stops adding at the per-project limit', async () => {
    const items = Array.from({ length: REQUIREMENTS_PER_PROJECT_MAX }, (_, index) => ({
      id: `old${index}`,
      title: `old ${index}`,
      status: 'open',
      source: user,
      createdAt: index,
      updatedAt: index,
    }));
    const { service } = setup({ p: { version: 1, items } });
    await expect(service.add('p', { title: 'one more' }, user)).rejects.toThrow(
      `This project already has ${REQUIREMENTS_PER_PROJECT_MAX} requirements`
    );
  });

  it('rejects a blank title', async () => {
    const { service } = setup();
    await expect(service.add('p', { title: '   ' }, user)).rejects.toThrow(
      'A requirement needs a title'
    );
    const { id } = await service.add('p', { title: 'ok' }, user);
    await expect(service.update('p', id, { title: ' ' })).rejects.toThrow(
      'A requirement needs a title'
    );
  });

  it('keeps both of two adds sent at once', async () => {
    const { service } = setup();
    await Promise.all([
      service.add('p', { title: 'first' }, user),
      service.add('p', { title: 'second' }, agent),
    ]);
    expect((await service.list('p')).map((item) => item.title).sort()).toEqual(['first', 'second']);
  });

  it('tells the window, naming the agent when an agent added one', async () => {
    const { service, events } = setup();
    await service.add('p', { title: 'from agent' }, agent);
    await service.add('p', { title: 'from user' }, user);
    expect(events).toEqual([
      { projectId: 'p', addedByAgent: { title: 'from agent', providerId: 'claude' } },
      { projectId: 'p' },
    ]);
  });

  it('does not tell the window when the write fails, and keeps going after it', async () => {
    const { service, store, events } = setup();
    vi.mocked(store.setOrThrow).mockRejectedValueOnce(new Error('disk full'));
    const results = await Promise.allSettled([
      service.add('p', { title: 'lost' }, user),
      service.add('p', { title: 'kept' }, user),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(events).toEqual([{ projectId: 'p' }]);
    expect((await service.list('p')).map((item) => item.title)).toEqual(['kept']);
  });

  it('stores a sub-requirement under a top-level parent and keeps version 1', async () => {
    const { service, data } = setup();
    const parent = await service.add('p', { title: 'parent' }, user);
    const child = await service.add('p', { title: 'child', parentId: parent.id }, user);
    expect(child).toMatchObject({ parentId: parent.id, status: 'open' });
    expect((await service.list('p')).find((item) => item.id === parent.id)?.status).toBe('open');
    const stored = data.get('p') as ProjectRequirements;
    expect(stored.version).toBe(1);
    expect(stored.items.map((item) => item.parentId ?? null)).toEqual([null, parent.id]);
  });

  it('rejects a sub-requirement of a sub-requirement and leaves the list unchanged', async () => {
    const { service, data } = setup();
    const parent = await service.add('p', { title: 'parent' }, user);
    const child = await service.add('p', { title: 'child', parentId: parent.id }, user);
    const before = structuredClone(data.get('p'));
    await expect(service.add('p', { title: 'grand', parentId: child.id }, user)).rejects.toThrow(
      'A sub-requirement cannot contain another'
    );
    expect(data.get('p')).toEqual(before);
  });

  it('rejects a missing parent, a self parent, and nesting a parent', async () => {
    const { service } = setup();
    await expect(service.add('p', { title: 'orphan', parentId: 'missing' }, user)).rejects.toThrow(
      'No requirement missing in this project'
    );
    const parent = await service.add('p', { title: 'parent' }, user);
    const other = await service.add('p', { title: 'other' }, user);
    await service.add('p', { title: 'child', parentId: parent.id }, user);
    await expect(service.update('p', parent.id, { parentId: parent.id })).rejects.toThrow(
      'A requirement cannot be its own parent'
    );
    await expect(service.update('p', parent.id, { parentId: other.id })).rejects.toThrow(
      'A requirement with sub-requirements stays at the top level'
    );
  });

  it('moves a requirement under another top-level one and clears the parent', async () => {
    const { service, data } = setup();
    const parent = await service.add('p', { title: 'parent' }, user);
    const other = await service.add('p', { title: 'other' }, user);
    expect((await service.update('p', other.id, { parentId: parent.id })).parentId).toBe(parent.id);
    const cleared = await service.update('p', other.id, { parentId: '' });
    expect(cleared).not.toHaveProperty('parentId');
    const stored = (data.get('p') as ProjectRequirements).items.find(
      (item) => item.id === other.id
    );
    expect(stored).not.toHaveProperty('parentId');
  });

  it('deletes a parent with its sub-requirements and deletes one sub-requirement alone', async () => {
    const { service } = setup();
    const parent = await service.add('p', { title: 'parent' }, user);
    await service.add('p', { title: 'one', parentId: parent.id }, user);
    const two = await service.add('p', { title: 'two', parentId: parent.id }, user);
    await service.add('p', { title: 'sibling' }, user);
    await service.remove('p', two.id);
    expect((await service.list('p')).map((item) => item.title).sort()).toEqual([
      'one',
      'parent',
      'sibling',
    ]);
    await service.remove('p', parent.id);
    expect((await service.list('p')).map((item) => item.title)).toEqual(['sibling']);
  });

  it('reads a list written before parentId existed', async () => {
    const old = {
      id: 'old',
      title: 'already here',
      status: 'open' as const,
      source: user,
      createdAt: 1,
      updatedAt: 1,
    };
    const { service } = setup({ p: { version: 1, items: [old] } });
    const listed = await service.list('p');
    expect(listed).toEqual([old]);
    expect(listed[0]).not.toHaveProperty('parentId');
    expect((await service.add('p', { title: 'child', parentId: 'old' }, user)).parentId).toBe(
      'old'
    );
  });

  it('keeps parent and sub-requirement status independent, including a dangling parent', async () => {
    const { service } = setup();
    const parent = await service.add('p', { title: 'parent' }, user);
    const child = await service.add('p', { title: 'child', parentId: parent.id }, user);
    await service.update('p', child.id, { status: 'done' });
    expect((await service.list('p')).find((item) => item.id === parent.id)?.status).toBe('open');
    await service.update('p', parent.id, { status: 'done' });
    expect((await service.list('p')).find((item) => item.id === child.id)?.status).toBe('done');

    const dangling = {
      id: 'dangling',
      title: 'dangling',
      parentId: 'gone',
      status: 'open' as const,
      source: user,
      createdAt: 1,
      updatedAt: 1,
    };
    const { service: second } = setup({ p: { version: 1, items: [dangling] } });
    const done = await second.update('p', 'dangling', { status: 'done' });
    expect(done).toMatchObject({ status: 'done', parentId: 'gone' });
  });

  it("drops only the deleted project's list", async () => {
    const { service, data } = setup();
    await service.add('p', { title: 'one' }, user);
    await service.add('q', { title: 'other' }, user);
    await service.removeProject('p');
    expect(data.has('p')).toBe(false);
    expect(data.has('q')).toBe(true);
  });
});
