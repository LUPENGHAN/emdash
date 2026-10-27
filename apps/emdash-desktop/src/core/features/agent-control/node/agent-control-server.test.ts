import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Requirement } from '@core/features/requirements/api/types';
import type { AgentControlAction } from '../api';
import { startAgentControlServer, type AgentControlServer } from './agent-control-server';

const caller = {
  conversationId: 'conv-1',
  taskId: 'task-1',
  projectId: 'project-1',
  providerId: 'claude',
  title: 'Fix the parser',
  cwd: '/work/parser',
};

describe('startAgentControlServer', () => {
  let server: AgentControlServer;
  const dispatch = vi.fn(async (_caller: unknown, action: AgentControlAction) => ({
    text: `did ${action.kind}`,
  }));
  const requirement: Requirement = {
    id: 'r1',
    title: 'Retry on timeout',
    detail: 'in the fetch layer',
    status: 'open',
    source: { kind: 'user' },
    createdAt: 1,
    updatedAt: 1,
  };
  const requirements = {
    list: vi.fn(async () => [requirement]),
    add: vi.fn(async (_projectId: string, input: { title: string }) => ({
      ...requirement,
      title: input.title,
    })),
    update: vi.fn(async () => ({ ...requirement, status: 'done' as const })),
    remove: vi.fn(async () => undefined),
  };
  const memory = {
    list: vi.fn(async () => []),
    add: vi.fn(),
    get: vi.fn(),
  };

  beforeEach(async () => {
    dispatch.mockClear();
    requirements.add.mockClear();
    server = await startAgentControlServer({
      secret: Buffer.from('test-secret'),
      version: '1.0.0',
      preferredPort: 0,
      resolveCaller: async (id) => (id === 'conv-1' ? caller : null),
      dispatch,
      usageLimits: async () => ({
        agents: [
          {
            agent: 'claude',
            plan: 'max',
            observedAt: 1,
            windows: [{ label: '5h', usedPercent: 91, resets: '3pm' }],
          },
        ],
      }),
      requirements,
      memory,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  async function connect(url: string) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }

  it('lists the tools and answers whoami and usage for the signed conversation', async () => {
    const client = await connect(server.urlFor('conv-1'));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['whoami', 'handoff', 'read_terminal', 'browser_snapshot'])
    );

    const whoami = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.stringify(whoami.content)).toContain('You are claude');
    expect(JSON.stringify(whoami.content)).toContain('/work/parser');

    const usage = await client.callTool({ name: 'usage_limits', arguments: {} });
    expect(JSON.stringify(usage.content)).toContain('5h 91% used, resets 3pm');
    await client.close();
  });

  it('hands actions to the dispatcher with the calling conversation', async () => {
    const client = await connect(server.urlFor('conv-1'));
    const result = await client.callTool({
      name: 'handoff',
      arguments: { agent: 'codex', note: 'tests are failing' },
    });
    expect(JSON.stringify(result.content)).toContain('did handoff');
    expect(dispatch).toHaveBeenCalledWith(caller, {
      kind: 'handoff',
      providerId: 'codex',
      model: undefined,
      note: 'tests are failing',
    });

    dispatch.mockRejectedValueOnce(new Error('The user declined'));
    const declined = await client.callTool({
      name: 'run_in_terminal',
      arguments: { command: 'rm -rf /' },
    });
    expect(declined.isError).toBe(true);
    expect(JSON.stringify(declined.content)).toContain('The user declined');
    await client.close();
  });

  it("keeps the caller's project requirements list, as that agent", async () => {
    const client = await connect(server.urlFor('conv-1'));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['add_requirement', 'list_requirements', 'complete_requirement'])
    );

    const added = await client.callTool({
      name: 'add_requirement',
      arguments: { title: 'Cache the token' },
    });
    expect(JSON.stringify(added.content)).toContain('Added requirement r1: Cache the token');
    expect(requirements.add).toHaveBeenCalledWith(
      'project-1',
      { title: 'Cache the token', detail: undefined },
      { kind: 'agent', providerId: 'claude', conversationId: 'conv-1', taskId: 'task-1' }
    );

    const listed = await client.callTool({ name: 'list_requirements', arguments: {} });
    expect(JSON.stringify(listed.content)).toContain(
      'r1 [open] Retry on timeout\\n  in the fetch layer'
    );

    await client.callTool({ name: 'complete_requirement', arguments: { id: 'r1' } });
    expect(requirements.update).toHaveBeenCalledWith('project-1', 'r1', { status: 'done' });

    requirements.list.mockResolvedValueOnce([
      {
        ...requirement,
        id: 'child',
        title: 'Child',
        parentId: 'r1',
        createdAt: 2,
        detail: 'under',
      },
      requirement,
    ]);
    const nested = await client.callTool({
      name: 'list_requirements',
      arguments: { status: 'all' },
    });
    expect(JSON.stringify(nested.content)).toContain(
      'r1 [open] Retry on timeout\\n  in the fetch layer\\n  child [open] Child parent:r1\\n    under'
    );

    await client.callTool({
      name: 'add_requirement',
      arguments: { title: 'Child', parentId: 'r1' },
    });
    expect(requirements.add).toHaveBeenCalledWith(
      'project-1',
      { title: 'Child', detail: undefined, parentId: 'r1' },
      { kind: 'agent', providerId: 'claude', conversationId: 'conv-1', taskId: 'task-1' }
    );

    requirements.add.mockRejectedValueOnce(new Error('This project already has 500 requirements'));
    const failed = await client.callTool({ name: 'add_requirement', arguments: { title: 'x' } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('already has 500 requirements');
    await client.close();
  });

  it('rejects forged paths and foreign Host headers', async () => {
    const forged = server.urlFor('conv-1').replace(/[^/]+$/, 'forged');
    await expect(connect(forged)).rejects.toThrow();

    const status = await new Promise<number>((resolve) => {
      const url = new URL(server.urlFor('conv-1'));
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: url.pathname,
          method: 'POST',
          headers: { host: 'evil.example', 'content-type': 'application/json' },
        },
        (res) => resolve(res.statusCode ?? 0)
      );
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
