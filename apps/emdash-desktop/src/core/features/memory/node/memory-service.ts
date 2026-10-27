import {
  MEMORY_DETAIL_MAX,
  MEMORY_PER_LIST_MAX,
  MEMORY_TITLE_MAX,
  memoryRecordSchema,
  projectMemorySchema,
  type MemoryChanges,
  type MemoryEvent,
  type MemoryOperations,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
  type ProjectMemory,
} from '../api/types';

/** One KV namespace. Project ids and the global key live in different stores. */
export type MemoryStore = {
  getOrThrow(key: string): Promise<unknown | null>;
  setOrThrow(key: string, value: ProjectMemory): Promise<void>;
  del(key: string): Promise<void>;
};

export const GLOBAL_MEMORY_KEY = 'global';

/**
 * Project decisions and global decisions. A project id cannot overwrite the global
 * list, because the two lists are different namespaces. The repository root and every
 * worktree share a project list: callers already pass the project id, not the checkout.
 */
export class MemoryService implements MemoryOperations {
  private readonly projectStore: MemoryStore;
  private readonly globalStore: MemoryStore;
  private readonly emit: (event: MemoryEvent) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    projects: MemoryStore;
    global: MemoryStore;
    emit: (event: MemoryEvent) => void;
    now?: () => number;
    newId?: () => string;
  }) {
    this.projectStore = options.projects;
    this.globalStore = options.global;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Newest first. */
  async list(scope: MemoryScope): Promise<MemoryRecord[]> {
    const { items } = await this.read(scope);
    return [...items].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  async get(scope: MemoryScope, id: string): Promise<MemoryRecord> {
    const item = (await this.read(scope)).items.find((entry) => entry.id === id);
    if (!item) throw new Error(`No decision ${id}`);
    return item;
  }

  add(
    scope: MemoryScope,
    input: { title: string; detail?: string },
    source: MemorySource
  ): Promise<MemoryRecord> {
    return this.write(scope, (list) => {
      if (list.items.length >= MEMORY_PER_LIST_MAX) {
        throw new Error(
          `This list already has ${MEMORY_PER_LIST_MAX} decisions; delete some before adding another`
        );
      }
      const now = this.now();
      const item = validated({
        id: this.newId(),
        title: cleanTitle(input.title),
        detail: cleanDetail(input.detail),
        source,
        createdAt: now,
        updatedAt: now,
      });
      return { next: { ...list, items: [...list.items, item] }, result: item };
    });
  }

  update(scope: MemoryScope, id: string, changes: MemoryChanges): Promise<MemoryRecord> {
    if (changes.title === undefined && changes.detail === undefined) {
      return Promise.reject(new Error('Pass a title, a detail, or both'));
    }
    return this.write(scope, (list) => {
      const index = list.items.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error(`No decision ${id}`);
      const current = list.items[index]!;
      const nextItem = validated({
        ...current,
        title: changes.title === undefined ? current.title : cleanTitle(changes.title),
        detail: changes.detail === undefined ? current.detail : cleanDetail(changes.detail),
        updatedAt: this.now(),
      });
      const items = list.items.slice();
      items[index] = nextItem;
      return { next: { ...list, items }, result: nextItem };
    });
  }

  remove(scope: MemoryScope, id: string): Promise<void> {
    return this.write(scope, (list) => ({
      next: { ...list, items: list.items.filter((entry) => entry.id !== id) },
      result: undefined,
    }));
  }

  async removeProject(projectId: string): Promise<void> {
    await this.enqueue({ kind: 'project', projectId }, () => this.projectStore.del(projectId));
  }

  private location(scope: MemoryScope): { store: MemoryStore; key: string } {
    if (scope.kind === 'global') return { store: this.globalStore, key: GLOBAL_MEMORY_KEY };
    return { store: this.projectStore, key: scope.projectId };
  }

  private async read(scope: MemoryScope): Promise<ProjectMemory> {
    const { store, key } = this.location(scope);
    const raw = await store.getOrThrow(key);
    if (raw === null) return { version: 1, items: [] };
    const parsed = projectMemorySchema.safeParse(raw);
    if (!parsed.success) throw new Error('Decisions could not be read');
    return parsed.data;
  }

  private write<T>(
    scope: MemoryScope,
    change: (list: ProjectMemory) => { next: ProjectMemory; result: T }
  ): Promise<T> {
    return this.enqueue(scope, async () => {
      const { next, result } = change(await this.read(scope));
      const { store, key } = this.location(scope);
      await store.setOrThrow(key, next);
      this.emit(eventFor(scope));
      return result;
    });
  }

  private enqueue<T>(scope: MemoryScope, work: () => Promise<T>): Promise<T> {
    const key = scope.kind === 'project' ? `project:${scope.projectId}` : 'global';
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    this.queues.set(key, run);
    void run
      .catch(() => {})
      .then(() => {
        if (this.queues.get(key) === run) this.queues.delete(key);
      });
    return run;
  }
}

function eventFor(scope: MemoryScope): MemoryEvent {
  return scope.kind === 'project'
    ? { scope: 'project', projectId: scope.projectId }
    : { scope: 'global' };
}

function cleanTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('A decision needs a title');
  if (trimmed.length > MEMORY_TITLE_MAX) {
    throw new Error(`A decision title can be at most ${MEMORY_TITLE_MAX} characters`);
  }
  return trimmed;
}

function cleanDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MEMORY_DETAIL_MAX) {
    throw new Error(`A decision body can be at most ${MEMORY_DETAIL_MAX} characters`);
  }
  return trimmed;
}

function validated(item: {
  id: string;
  title: string;
  detail?: string;
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
}): MemoryRecord {
  const parsed = memoryRecordSchema.safeParse(item);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid decision');
  return parsed.data;
}
