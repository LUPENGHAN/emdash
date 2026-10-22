import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
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
