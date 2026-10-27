import {
  projectRequirementsSchema,
  REQUIREMENTS_PER_PROJECT_MAX,
  requirementSchema,
  type ProjectRequirements,
  type Requirement,
  type RequirementChanges,
  type RequirementSource,
  type RequirementsEvent,
  type RequirementsOperations,
} from '../api/types';

/** Where each project's list lives: one record per project id. */
export type RequirementsStore = {
  getOrThrow(projectId: string): Promise<unknown | null>;
  setOrThrow(projectId: string, value: ProjectRequirements): Promise<void>;
  del(projectId: string): Promise<void>;
};

/**
 * Each project's requirements list, edited by the user (Wire) and by agents (MCP). Writes
 * to one project run one after another, so two at once cannot lose either.
 */
export class RequirementsService implements RequirementsOperations {
  private readonly store: RequirementsStore;
  private readonly emit: (event: RequirementsEvent) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    store: RequirementsStore;
    emit: (event: RequirementsEvent) => void;
    now?: () => number;
    newId?: () => string;
  }) {
    this.store = options.store;
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Open ones first, each group newest first. */
  async list(projectId: string): Promise<Requirement[]> {
    const { items } = await this.read(projectId);
    return [...items].sort(
      (a, b) =>
        Number(a.status === 'done') - Number(b.status === 'done') || b.createdAt - a.createdAt
    );
  }

  add(
    projectId: string,
    input: { title: string; detail?: string; parentId?: string },
    source: RequirementSource
  ): Promise<Requirement> {
    return this.write(projectId, (list) => {
      if (list.items.length >= REQUIREMENTS_PER_PROJECT_MAX) {
        throw new Error(
          `This project already has ${REQUIREMENTS_PER_PROJECT_MAX} requirements; finish or delete some first`
        );
      }
      const now = this.now();
      const detail = input.detail?.trim();
      const parentId = input.parentId?.trim() || undefined;
      assertAttachable(list, null, parentId);
      const item = validated({
        id: this.newId(),
        title: input.title.trim(),
        ...(detail && { detail }),
        ...(parentId && { parentId }),
        status: 'open',
        source,
        createdAt: now,
        updatedAt: now,
      });
      const event: RequirementsEvent =
        source.kind === 'agent'
          ? { projectId, addedByAgent: { title: item.title, providerId: source.providerId } }
          : { projectId };
      return { next: { ...list, items: [...list.items, item] }, result: item, event };
    });
  }

  update(projectId: string, id: string, changes: RequirementChanges): Promise<Requirement> {
    return this.write(projectId, (list) => {
      const current = list.items.find((item) => item.id === id);
      if (!current) throw new Error(`No requirement ${id} in this project`);
      const { detail: _previous, parentId: _previousParent, ...rest } = current;
      const detail = changes.detail === undefined ? current.detail : changes.detail.trim();
      const parentId =
        changes.parentId === undefined ? current.parentId : changes.parentId.trim() || undefined;
      if (changes.parentId !== undefined) assertAttachable(list, current.id, parentId);
      const item = validated({
        ...rest,
        ...(changes.title !== undefined && { title: changes.title.trim() }),
        ...(detail && { detail }),
        ...(parentId && { parentId }),
        ...(changes.status && { status: changes.status }),
        updatedAt: this.now(),
      });
      return {
        next: { ...list, items: list.items.map((other) => (other.id === id ? item : other)) },
        result: item,
        event: { projectId },
      };
    });
  }

  async remove(projectId: string, id: string): Promise<void> {
    await this.write(projectId, (list) => ({
      next: {
        ...list,
        items: list.items.filter((item) => item.id !== id && item.parentId !== id),
      },
      result: undefined,
      event: { projectId },
    }));
  }

  /** Drops the project's whole list, when the project itself is deleted. */
  async removeProject(projectId: string): Promise<void> {
    await this.enqueue(projectId, () => this.store.del(projectId));
  }

  private async read(projectId: string): Promise<ProjectRequirements> {
    const raw = await this.store.getOrThrow(projectId);
    if (raw === null) return { version: 1, items: [] };
    const parsed = projectRequirementsSchema.safeParse(raw);
    // Never treat unreadable data as an empty list: the next write would replace it.
    if (!parsed.success) throw new Error('Requirements for this project could not be read');
    return parsed.data;
  }

  private write<T>(
    projectId: string,
    change: (list: ProjectRequirements) => {
      next: ProjectRequirements;
      result: T;
      event: RequirementsEvent;
    }
  ): Promise<T> {
    return this.enqueue(projectId, async () => {
      const { next, result, event } = change(await this.read(projectId));
      await this.store.setOrThrow(projectId, next);
      this.emit(event);
      return result;
    });
  }

  private enqueue<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    this.queues.set(projectId, run);
    void run
      .catch(() => {})
      .then(() => {
        if (this.queues.get(projectId) === run) this.queues.delete(projectId);
      });
    return run;
  }
}

function validated(item: Requirement): Requirement {
  if (!item.title) throw new Error('A requirement needs a title');
  const parsed = requirementSchema.safeParse(item);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid requirement');
  return parsed.data;
}

/** parentId is checked only when it is being set. A missing parent does not block other edits. */
function assertAttachable(
  list: ProjectRequirements,
  itemId: string | null,
  parentId: string | undefined
) {
  if (!parentId) return;
  if (itemId !== null && parentId === itemId) {
    throw new Error('A requirement cannot be its own parent');
  }
  const parent = list.items.find((item) => item.id === parentId);
  if (!parent) throw new Error(`No requirement ${parentId} in this project`);
  if (parent.parentId) throw new Error('A sub-requirement cannot contain another');
  if (itemId !== null && list.items.some((item) => item.parentId === itemId)) {
    throw new Error('A requirement with sub-requirements stays at the top level');
  }
}
