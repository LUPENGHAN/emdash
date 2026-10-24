import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
    requirements: { list: vi.fn(), add: vi.fn(), update: vi.fn() },
  } satisfies AgentControlToolContext);
  return { dispatch, tool: (name: string) => tools.find((entry) => entry.name === name) };
}

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
