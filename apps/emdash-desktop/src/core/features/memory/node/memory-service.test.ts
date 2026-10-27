import { describe, expect, it, vi } from 'vitest';
import type { MemoryEvent, ProjectMemory } from '../api/types';
import { MEMORY_PER_LIST_MAX } from '../api/types';
import { GLOBAL_MEMORY_KEY, MemoryService, type MemoryStore } from './memory-service';

function storeFor(data: Map<string, unknown>): MemoryStore {
  return {
    getOrThrow: vi.fn(async (key: string) => structuredClone(data.get(key) ?? null)),
    setOrThrow: vi.fn(async (key: string, value: ProjectMemory) => {
      data.set(key, structuredClone(value));
    }),
    del: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
}

function setup() {
  const projects = new Map<string, unknown>();
  const global = new Map<string, unknown>();
  const events: MemoryEvent[] = [];
  let clock = 1000;
  let ids = 0;
  const service = new MemoryService({
    projects: storeFor(projects),
    global: storeFor(global),
    emit: (event) => events.push(event),
    now: () => clock++,
    newId: () => `m${++ids}`,
  });
  return { service, projects, global, events };
}

const user = { kind: 'user' } as const;
const agent = {
  kind: 'agent',
  providerId: 'claude',
  conversationId: 'conv-1',
  taskId: 'task-1',
} as const;
const project = { kind: 'project', projectId: 'p1' } as const;
const globalScope = { kind: 'global' } as const;

describe('MemoryService', () => {
  it('keeps project and global lists apart, including a project id named global', async () => {
    const { service, events } = setup();
    await service.add({ kind: 'project', projectId: 'global' }, { title: 'In the project' }, user);
    await service.add(globalScope, { title: 'Everywhere' }, user);
    expect(
      (await service.list({ kind: 'project', projectId: 'global' })).map((item) => item.title)
    ).toEqual(['In the project']);
    expect((await service.list(globalScope)).map((item) => item.title)).toEqual(['Everywhere']);
    expect(events).toEqual([{ scope: 'project', projectId: 'global' }, { scope: 'global' }]);
  });

  it('shares one list for a project id, newest first, and records who wrote it', async () => {
    const { service } = setup();
    await service.add(project, { title: 'older' }, user);
    await service.add(project, { title: '  newer  ', detail: '  because  ' }, agent);
    const items = await service.list(project);
    expect(items.map((item) => item.title)).toEqual(['newer', 'older']);
    expect(items[0]).toMatchObject({ detail: 'because', source: agent, id: 'm2' });
    expect(items[0]?.detail).toBe('because');
    expect((await service.get(project, 'm2')).title).toBe('newer');
  });

  it('omits an empty body and clears it on update without changing the author', async () => {
    const { service } = setup();
    await service.add(project, { title: 'Keep', detail: '   ' }, agent);
    expect((await service.get(project, 'm1')).detail).toBeUndefined();
    const updated = await service.update(project, 'm1', { detail: '' });
    expect(updated.detail).toBeUndefined();
    expect(updated.source).toEqual(agent);
    expect(updated.createdAt).toBe(1000);
    await expect(service.update(project, 'm1', {})).rejects.toThrow(
      'Pass a title, a detail, or both'
    );
    await expect(service.get(project, 'missing')).rejects.toThrow('No decision missing');
  });

  it('rejects the 501st decision and leaves the list', async () => {
    const { service, projects } = setup();
    for (let i = 0; i < MEMORY_PER_LIST_MAX; i += 1) {
      await service.add(project, { title: `d${i}` }, user);
    }
    await expect(service.add(project, { title: 'one more' }, user)).rejects.toThrow(
      '500 decisions'
    );
    expect((projects.get('p1') as ProjectMemory).items).toHaveLength(MEMORY_PER_LIST_MAX);
  });

  it('does not replace unreadable data with an empty list', async () => {
    const projects = new Map<string, unknown>([['p1', { version: 1, items: 'nope' }]]);
    const global = new Map<string, unknown>();
    const service = new MemoryService({
      projects: storeFor(projects),
      global: storeFor(global),
      emit: () => {},
    });
    await expect(service.list(project)).rejects.toThrow('Decisions could not be read');
    await expect(service.add(project, { title: 'overwrite' }, user)).rejects.toThrow(
      'Decisions could not be read'
    );
    expect(projects.get('p1')).toEqual({ version: 1, items: 'nope' });
  });

  it('drops only that project when the project is deleted', async () => {
    const { service, projects, global } = setup();
    await service.add(project, { title: 'local' }, user);
    await service.add({ kind: 'project', projectId: 'p2' }, { title: 'other' }, user);
    await service.add(globalScope, { title: 'everywhere' }, user);
    await service.removeProject('p1');
    expect(projects.has('p1')).toBe(false);
    expect(projects.has('p2')).toBe(true);
    expect(global.get(GLOBAL_MEMORY_KEY)).toBeTruthy();
  });
});
