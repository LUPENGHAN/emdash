import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { MemoryRecord, MemoryScope, MemorySource } from '@core/features/memory/api/types';
import type { Requirement } from '@core/features/requirements/api/types';
import { NAVIGATION_COMMAND_IDS } from '../api';
import type { AgentControlToolContext } from './mcp-tools';
import { registerAgentControlTools } from './mcp-tools';

type RegisteredTool = {
  name: string;
  config: {
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

/** Records registerTool calls; the context dispatches to a test double. */
function registeredTools() {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler']
    ) {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  const dispatch = vi.fn(async () => ({ text: 'ok' }));
  const requirements = {
    list: vi.fn(async (): Promise<Requirement[]> => []),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
  const memory = memoryLists();
  registerAgentControlTools(server, {
    caller: {
      conversationId: 'c1',
      taskId: 't1',
      projectId: 'p1',
      providerId: 'codex',
      title: 'probe',
      cwd: null,
    },
    dispatch,
    usageLimits: async () => ({ agents: [] }),
    requirements,
    memory,
  } satisfies AgentControlToolContext);
  return {
    dispatch,
    requirements,
    memory,
    tool: (name: string) => tools.find((entry) => entry.name === name),
  };
}

function requirement(id: string, extra: Partial<Requirement> = {}): Requirement {
  return {
    id,
    title: id,
    status: 'open',
    source: { kind: 'user' },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

/** Project lists and the global list stay separate, the way the service does. */
function memoryLists() {
  const project = new Map<string, MemoryRecord[]>();
  const global: MemoryRecord[] = [];
  let ids = 0;
  const list = vi.fn(async (scope: MemoryScope) => {
    const items = scope.kind === 'global' ? global : (project.get(scope.projectId) ?? []);
    return items.map((item) => ({ ...item }));
  });
  const add = vi.fn(
    async (
      scope: MemoryScope,
      input: { title: string; detail?: string },
      source: MemorySource
    ): Promise<MemoryRecord> => {
      const detail = input.detail?.trim();
      const item: MemoryRecord = {
        id: `m${++ids}`,
        title: input.title.trim(),
        ...(detail ? { detail } : {}),
        source,
        createdAt: ids,
        updatedAt: ids,
      };
      if (scope.kind === 'global') global.push(item);
      else project.set(scope.projectId, [...(project.get(scope.projectId) ?? []), item]);
      return item;
    }
  );
  const get = vi.fn(async (scope: MemoryScope, id: string) => {
    const items = scope.kind === 'global' ? global : (project.get(scope.projectId) ?? []);
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error(`No decision ${id}`);
    return item;
  });
  const update = vi.fn(
    async (
      scope: MemoryScope,
      id: string,
      changes: { title?: string; detail?: string }
    ): Promise<MemoryRecord> => {
      const items = scope.kind === 'global' ? global : (project.get(scope.projectId) ?? []);
      const current = items.find((entry) => entry.id === id);
      if (!current) throw new Error(`No decision ${id}`);
      if (changes.title !== undefined) current.title = changes.title;
      if (changes.detail !== undefined) {
        const detail = changes.detail.trim();
        if (detail) current.detail = detail;
        else delete current.detail;
      }
      return { ...current };
    }
  );
  const remove = vi.fn(async (scope: MemoryScope, id: string) => {
    if (scope.kind === 'global') {
      const index = global.findIndex((entry) => entry.id === id);
      if (index >= 0) global.splice(index, 1);
      return;
    }
    const items = project.get(scope.projectId);
    if (!items) return;
    project.set(
      scope.projectId,
      items.filter((entry) => entry.id !== id)
    );
  });
  return { list, add, get, update, remove };
}

/**
 * One list per project. update and remove change only the project they are given,
 * and remove also drops that item's sub-requirements, as the service does.
 */
function requirementLists(initial: Record<string, Requirement[]>) {
  const data = new Map(
    Object.entries(initial).map(([projectId, items]) => [
      projectId,
      items.map((item) => ({ ...item })),
    ])
  );
  const list = vi.fn(async (projectId: string) =>
    (data.get(projectId) ?? []).map((item) => ({ ...item }))
  );
  const update = vi.fn(
    async (
      projectId: string,
      id: string,
      changes: { title?: string; detail?: string }
    ): Promise<Requirement> => {
      const current = data.get(projectId)?.find((item) => item.id === id);
      if (!current) throw new Error(`No requirement ${id} in this project`);
      if (changes.title !== undefined) current.title = changes.title;
      if (changes.detail !== undefined) {
        const detail = changes.detail.trim();
        if (detail) current.detail = detail;
        else delete current.detail;
      }
      return { ...current };
    }
  );
  const remove = vi.fn(async (projectId: string, id: string) => {
    const items = data.get(projectId);
    if (!items) return;
    data.set(
      projectId,
      items.filter((item) => item.id !== id && item.parentId !== id)
    );
  });
  return { list, update, remove, add: vi.fn() };
}

function requirementTools(initial: Record<string, Requirement[]>) {
  const tools: RegisteredTool[] = [];
  const dispatch = vi.fn(async () => ({ text: 'Confirmed.' }));
  const requirements = requirementLists(initial);
  registerAgentControlTools(
    {
      registerTool(
        name: string,
        config: RegisteredTool['config'],
        handler: RegisteredTool['handler']
      ) {
        tools.push({ name, config, handler });
      },
    } as unknown as McpServer,
    {
      caller: {
        conversationId: 'c1',
        taskId: 't1',
        projectId: 'p1',
        providerId: 'codex',
        title: 'probe',
        cwd: null,
      },
      dispatch,
      usageLimits: async () => ({ agents: [] }),
      requirements,
      memory: memoryLists(),
    } satisfies AgentControlToolContext
  );
  return {
    dispatch,
    requirements,
    tool: (name: string) => tools.find((entry) => entry.name === name),
  };
}

describe('requirement tools', () => {
  it('adds a sub-requirement and indents the list under its parent', async () => {
    const { requirements, tool } = registeredTools();
    await tool('add_requirement')?.handler({ title: 'Child', parentId: 'parent' });
    expect(requirements.add).toHaveBeenCalledWith(
      'p1',
      { title: 'Child', detail: undefined, parentId: 'parent' },
      { kind: 'agent', providerId: 'codex', conversationId: 'c1', taskId: 't1' }
    );

    requirements.list.mockResolvedValueOnce([
      requirement('newer', { title: 'Newer', parentId: 'parent', createdAt: 3, detail: 'second' }),
      requirement('older', { title: 'Older', parentId: 'parent', createdAt: 2, detail: 'first' }),
      requirement('parent', { title: 'Parent', createdAt: 1, detail: 'over' }),
    ]);
    const listed = await tool('list_requirements')?.handler({ status: 'all' });
    expect(listed).toMatchObject({
      content: [
        {
          text: [
            'parent [open] Parent',
            '  over',
            '  older [open] Older parent:parent',
            '    first',
            '  newer [open] Newer parent:parent',
            '    second',
          ].join('\n'),
        },
      ],
    });
  });

  it('updates one requirement in this project and can clear its detail', async () => {
    const { requirements, tool } = requirementTools({
      p1: [requirement('r1', { title: 'Retry', detail: 'old', parentId: 'keep' })],
      other: [requirement('r1', { title: 'Elsewhere', detail: 'keep me' })],
    });

    const updated = await tool('update_requirement')?.handler({
      id: 'r1',
      title: 'Retry later',
      detail: '',
      parentId: 'nope',
    });
    expect(updated).toMatchObject({
      content: [{ text: 'Updated requirement r1: Retry later' }],
    });
    expect(requirements.update).toHaveBeenCalledWith('p1', 'r1', {
      title: 'Retry later',
      detail: '',
    });
    expect(await requirements.list('p1')).toMatchObject([{ id: 'r1', title: 'Retry later' }]);
    expect((await requirements.list('p1'))[0]).not.toHaveProperty('detail');
    expect((await requirements.list('p1'))[0]?.parentId).toBe('keep');
    expect(await requirements.list('other')).toMatchObject([
      { id: 'r1', title: 'Elsewhere', detail: 'keep me' },
    ]);

    const missing = await tool('update_requirement')?.handler({ id: 'absent', title: 'x' });
    expect(missing).toMatchObject({
      isError: true,
      content: [{ text: 'No requirement absent in this project' }],
    });
    expect((await requirements.list('p1'))[0]?.title).toBe('Retry later');

    const callsBeforeEmpty = requirements.update.mock.calls.length;
    const empty = await tool('update_requirement')?.handler({ id: 'r1' });
    expect(empty).toMatchObject({
      isError: true,
      content: [{ text: 'Pass a title, a detail, or both' }],
    });
    expect(requirements.update).toHaveBeenCalledTimes(callsBeforeEmpty);
    expect((await requirements.list('p1'))[0]?.title).toBe('Retry later');
  });

  it('drops parentId and status from the update schema', () => {
    const { tool } = registeredTools();
    const schema = z.object(
      tool('update_requirement')?.config.inputSchema as {
        id: z.ZodType<string>;
        title: z.ZodOptional<z.ZodString>;
        detail: z.ZodOptional<z.ZodString>;
      }
    );
    expect(schema.safeParse({ id: 'r1', title: '' }).success).toBe(false);
    expect(schema.safeParse({ id: 'r1', detail: '' }).data).toEqual({ id: 'r1', detail: '' });
    expect(
      schema.safeParse({ id: 'r1', title: 'New', parentId: 'parent', status: 'done' }).data
    ).toEqual({ id: 'r1', title: 'New' });
  });

  it('deletes a requirement only after the user confirms, and only in this project', async () => {
    const child = requirement('child', { title: 'Child', parentId: 'parent' });
    const parent = requirement('parent', { title: 'Parent', detail: 'body' });
    const { dispatch, requirements, tool } = requirementTools({
      p1: [parent, child],
      other: [requirement('foreign', { title: 'Foreign' })],
    });

    const absent = await tool('delete_requirement')?.handler({ id: 'foreign' });
    expect(absent).toMatchObject({
      isError: true,
      content: [{ text: 'No requirement foreign in this project' }],
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(requirements.remove).not.toHaveBeenCalled();
    expect(await requirements.list('other')).toMatchObject([{ id: 'foreign' }]);

    dispatch.mockRejectedValueOnce(new Error('The user declined in Emdash.'));
    const declined = await tool('delete_requirement')?.handler({ id: 'parent' });
    expect(declined).toMatchObject({
      isError: true,
      content: [{ text: 'The user declined in Emdash.' }],
    });
    expect(requirements.remove).not.toHaveBeenCalled();
    expect((await requirements.list('p1')).map((item) => item.id).sort()).toEqual([
      'child',
      'parent',
    ]);

    dispatch.mockResolvedValueOnce({ text: 'Confirmed.' });
    const deleted = await tool('delete_requirement')?.handler({ id: 'parent' });
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: 'delete_requirement',
      id: 'parent',
      title: 'Parent',
      childCount: 1,
    });
    expect(deleted).toMatchObject({
      content: [{ text: 'Deleted requirement parent: Parent' }],
    });
    expect(requirements.remove).toHaveBeenCalledWith('p1', 'parent');
    expect(await requirements.list('p1')).toEqual([]);
    expect(await requirements.list('other')).toMatchObject([{ id: 'foreign' }]);
  });

  it('keeps a sub-requirement whose parent is outside the filtered list', async () => {
    const { requirements, tool } = registeredTools();
    requirements.list.mockResolvedValueOnce([
      requirement('child', { title: 'Child', parentId: 'parent', detail: 'alone' }),
    ]);
    const listed = await tool('list_requirements')?.handler({ status: 'open' });
    expect(listed).toMatchObject({
      content: [{ text: 'child [open] Child parent:parent\n  alone' }],
    });
  });
});

describe('registerAgentControlTools task tools', () => {
  it('registers list_tasks, archive_task and delete_task', () => {
    const { tool } = registeredTools();
    expect(tool('list_tasks')?.config.annotations).toEqual({ readOnlyHint: true });
    expect(tool('archive_task')).toBeDefined();
    expect(tool('delete_task')?.config.annotations).toEqual({ destructiveHint: true });
  });

  it('maps the tool arguments onto the dispatched actions', async () => {
    const { dispatch, tool } = registeredTools();
    await tool('list_tasks')?.handler({ include_archived: true });
    expect(dispatch).toHaveBeenCalledWith({ kind: 'list_tasks', includeArchived: true });
    await tool('archive_task')?.handler({ task_id: 't2' });
    expect(dispatch).toHaveBeenCalledWith({ kind: 'archive_task', taskId: 't2' });
    await tool('delete_task')?.handler({ task_id: 't3' });
    expect(dispatch).toHaveBeenCalledWith({ kind: 'delete_task', taskId: 't3' });
  });

  it('declares the list_tasks default in its schema', () => {
    const { tool } = registeredTools();
    const schema = tool('list_tasks')?.config.inputSchema as {
      include_archived?: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
    };
    expect(schema.include_archived?.safeParse(undefined)).toMatchObject({
      success: true,
      data: false,
    });
  });
});

const REFUSED_COMMAND_IDS = [
  'task.deleteSelected',
  'task.archive',
  'task.gitPush',
  'task.gitPull',
  'task.gitFetch',
  'app.voiceInput',
] as const;

describe('registerAgentControlTools navigation commands', () => {
  it('lists commands with an empty read-only input and does not run them', async () => {
    const { dispatch, tool } = registeredTools();
    const listed = tool('list_commands');

    expect(listed?.config.annotations).toEqual({ readOnlyHint: true });
    expect(listed?.config.inputSchema).toBeUndefined();

    await listed?.handler({});
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'list_commands' });
  });

  it('accepts only the navigation allowlist and drops extra fields', async () => {
    const { dispatch, tool } = registeredTools();
    const shape = tool('run_command')?.config.inputSchema as {
      command_id: z.ZodType<string>;
    };
    const schema = z.object(shape);

    for (const commandId of NAVIGATION_COMMAND_IDS) {
      expect(schema.safeParse({ command_id: commandId }).success).toBe(true);
    }
    for (const commandId of REFUSED_COMMAND_IDS) {
      expect(schema.safeParse({ command_id: commandId }).success).toBe(false);
    }

    const parsed = schema.safeParse({
      command_id: 'task.sidebarFiles',
      skipConfirm: true,
      force: true,
      source: 'menu',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ command_id: 'task.sidebarFiles' });

    await tool('run_command')?.handler({
      command_id: 'task.sidebarFiles',
      skipConfirm: true,
    });
    expect(dispatch).toHaveBeenCalledWith({
      kind: 'run_command',
      commandId: 'task.sidebarFiles',
    });
  });
});

describe('import_skill', () => {
  it('keeps command off the schema and the dispatched action', async () => {
    const { dispatch, tool } = registeredTools();
    const registered = tool('import_skill');
    expect(registered?.config.annotations).toEqual({ destructiveHint: true });
    const schema = z.object(
      registered?.config.inputSchema as {
        path: z.ZodType<string>;
        force: z.ZodType<boolean>;
      }
    );

    const plain = schema.safeParse({ path: '/tmp/skill', force: false, command: 'rm -rf /' });
    expect(plain.success).toBe(true);
    if (plain.success) expect(plain.data).toEqual({ path: '/tmp/skill', force: false });

    const forced = schema.safeParse({ path: '/tmp/skill', force: true, command: 'rm -rf /' });
    expect(forced.success).toBe(true);
    if (forced.success) expect(forced.data).toEqual({ path: '/tmp/skill', force: true });

    await registered?.handler({ path: '/tmp/skill' });
    await registered?.handler({ path: '/tmp/skill', force: true, command: 'rm -rf /' });
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      kind: 'import_skill',
      path: '/tmp/skill',
      force: false,
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      kind: 'import_skill',
      path: '/tmp/skill',
      force: true,
    });
  });
});

describe('memory tools', () => {
  it('appends and reads this project without taking a project id', async () => {
    const { memory, tool } = registeredTools();
    for (const name of [
      'add_project_memory',
      'list_project_memory',
      'get_project_memory',
      'update_project_memory',
      'delete_project_memory',
      'add_global_memory',
      'list_global_memory',
      'get_global_memory',
      'update_global_memory',
      'delete_global_memory',
    ]) {
      expect(tool(name)).toBeTruthy();
    }
    expect(tool('add_project_memory')?.config.inputSchema).not.toHaveProperty('projectId');
    expect(tool('update_project_memory')?.config.inputSchema).not.toHaveProperty('projectId');

    await tool('add_project_memory')?.handler({
      title: 'Share the list',
      detail: 'root and worktrees',
    });
    expect(memory.add).toHaveBeenCalledWith(
      { kind: 'project', projectId: 'p1' },
      { title: 'Share the list', detail: 'root and worktrees' },
      { kind: 'agent', providerId: 'codex', conversationId: 'c1', taskId: 't1' }
    );
    const listed = await tool('list_project_memory')?.handler({});
    expect(JSON.stringify(listed)).toContain('Share the list');
    expect(JSON.stringify(listed)).toContain('root and worktrees');
    const full = await tool('get_project_memory')?.handler({ id: 'm1' });
    expect(JSON.stringify(full)).toContain('root and worktrees');
    const missing = await tool('get_project_memory')?.handler({ id: 'missing' });
    expect(JSON.stringify(missing)).toContain('No decision missing');
  });

  it('updates a project decision at once and leaves the global list alone', async () => {
    const { dispatch, memory, tool } = registeredTools();
    await tool('add_project_memory')?.handler({ title: 'Share the list', detail: 'why' });
    await tool('add_global_memory')?.handler({ title: 'Imperative subjects' });

    const updated = await tool('update_project_memory')?.handler({ id: 'm1', detail: '' });
    expect(updated).toMatchObject({
      content: [{ text: 'Updated project decision m1: Share the list' }],
    });
    expect(memory.update).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 'm1', {
      detail: '',
    });
    expect(dispatch).not.toHaveBeenCalled();
    const projectList = await tool('list_project_memory')?.handler({});
    expect(JSON.stringify(projectList)).not.toContain('why');
    const globalList = await tool('list_global_memory')?.handler({});
    expect(JSON.stringify(globalList)).toContain('Imperative subjects');

    const callsBeforeEmpty = memory.update.mock.calls.length;
    const empty = await tool('update_project_memory')?.handler({ id: 'm1' });
    expect(empty).toMatchObject({
      isError: true,
      content: [{ text: 'Pass a title, a detail, or both' }],
    });
    expect(memory.update).toHaveBeenCalledTimes(callsBeforeEmpty);

    const absent = await tool('update_global_memory')?.handler({ id: 'm1', title: 'Nope' });
    expect(JSON.stringify(absent)).toContain('No decision m1');
  });

  it('deletes a project decision only after the user confirms', async () => {
    const { dispatch, tool } = registeredTools();
    await tool('add_project_memory')?.handler({ title: 'Share the list' });
    await tool('add_global_memory')?.handler({ title: 'Imperative subjects' });

    const absent = await tool('delete_project_memory')?.handler({ id: 'missing' });
    expect(absent).toMatchObject({
      isError: true,
      content: [{ text: 'No decision missing' }],
    });
    expect(dispatch).not.toHaveBeenCalled();

    dispatch.mockRejectedValueOnce(new Error('The user declined in Emdash.'));
    const declined = await tool('delete_project_memory')?.handler({ id: 'm1' });
    expect(declined).toMatchObject({
      isError: true,
      content: [{ text: 'The user declined in Emdash.' }],
    });
    const stillThere = await tool('list_project_memory')?.handler({});
    expect(JSON.stringify(stillThere)).toContain('Share the list');

    dispatch.mockResolvedValueOnce({ text: 'Confirmed.' });
    const deleted = await tool('delete_project_memory')?.handler({ id: 'm1' });
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: 'delete_project_memory',
      id: 'm1',
      title: 'Share the list',
    });
    expect(deleted).toMatchObject({
      content: [{ text: 'Deleted project decision m1: Share the list' }],
    });
    const projectList = await tool('list_project_memory')?.handler({});
    expect(JSON.stringify(projectList)).toContain('No decisions.');
    const globalList = await tool('list_global_memory')?.handler({});
    expect(JSON.stringify(globalList)).toContain('Imperative subjects');
  });

  it('keeps a global decision off the project list', async () => {
    const { tool } = registeredTools();
    await tool('add_global_memory')?.handler({
      title: 'Write commit subjects in the imperative',
    });
    const projectList = await tool('list_project_memory')?.handler({});
    const globalList = await tool('list_global_memory')?.handler({});
    expect(JSON.stringify(projectList)).toContain('No decisions.');
    expect(JSON.stringify(globalList)).toContain('imperative');
  });
});
