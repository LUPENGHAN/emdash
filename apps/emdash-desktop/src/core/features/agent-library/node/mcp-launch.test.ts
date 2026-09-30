import { describe, expect, it, vi } from 'vitest';
import type { LaunchMcpServer } from '../api';
import { acpMcpServers, launchableMcpServers, terminalLaunchForMcp } from './mcp-launch';

const servers: LaunchMcpServer[] = [
  { name: 'emdash', transport: 'http', url: 'http://127.0.0.1:47821/mcp/c/s' },
  {
    name: 'github tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/mcp "x"'],
    env: { GITHUB_TOKEN: 'secret', 'X-Y': '1' },
  },
];

describe('terminalLaunchForMcp', () => {
  it('gives Claude one --mcp-config=… argument with both transports', () => {
    const [arg] = terminalLaunchForMcp('claude', servers, {})!.args;
    const config = JSON.parse(arg!.slice('--mcp-config='.length));
    expect(config.mcpServers.emdash).toEqual({ type: 'http', url: servers[0]!.url });
    expect(config.mcpServers['github tools']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/mcp "x"'],
      env: { GITHUB_TOKEN: 'secret', 'X-Y': '1' },
    });
  });

  it('gives Codex TOML overrides with quoted keys and values', () => {
    expect(terminalLaunchForMcp('codex', servers, {})!.args).toEqual([
      '-c',
      'mcp_servers.emdash.url="http://127.0.0.1:47821/mcp/c/s"',
      '-c',
      'mcp_servers."github tools".command="npx"',
      '-c',
      'mcp_servers."github tools".args=["-y","@acme/mcp \\"x\\""]',
      '-c',
      'mcp_servers."github tools".env={GITHUB_TOKEN="secret",X-Y="1"}',
    ]);
  });

  it('merges into an existing inline OpenCode config', () => {
    const launch = terminalLaunchForMcp('opencode', servers, {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { gw: {} }, mcp: { mine: {} } }),
    })!;
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      provider: { gw: {} },
      mcp: {
        mine: {},
        emdash: { type: 'remote', url: servers[0]!.url, enabled: true },
        'github tools': {
          type: 'local',
          command: ['npx', '-y', '@acme/mcp "x"'],
          enabled: true,
          environment: { GITHUB_TOKEN: 'secret', 'X-Y': '1' },
        },
      },
    });
  });

  it('leaves agents without MCP, and empty lists, alone', () => {
    expect(terminalLaunchForMcp('pi', servers, {})).toBeNull();
    expect(terminalLaunchForMcp('claude', [], {})).toBeNull();
  });

  it('shapes ACP entries by transport', () => {
    expect(acpMcpServers(servers)).toEqual([
      { name: 'emdash', url: servers[0]!.url, headers: undefined },
      {
        name: 'github tools',
        command: 'npx',
        args: ['-y', '@acme/mcp "x"'],
        env: { GITHUB_TOKEN: 'secret', 'X-Y': '1' },
      },
    ]);
  });
});

describe('launchableMcpServers', () => {
  it('leaves out stdio servers whose command cannot start, and says why', async () => {
    const warn = vi.fn();
    const servers: LaunchMcpServer[] = [
      { name: 'npx', transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      { name: 'abs', transport: 'stdio', command: process.execPath },
      { name: 'web', transport: 'http', url: 'https://example.com/mcp' },
      {
        name: 'computer-use',
        transport: 'stdio',
        command: './Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient',
      },
      { name: 'gone', transport: 'stdio', command: '/nonexistent/bin/server' },
    ];

    const kept = await launchableMcpServers(servers, warn);

    expect(kept.map((server) => server.name)).toEqual(['npx', 'abs', 'web']);
    expect(warn).toHaveBeenCalledWith(
      'Leaving out an MCP server that cannot start',
      expect.objectContaining({ name: 'computer-use', reason: expect.stringContaining('relative') })
    );
    expect(warn).toHaveBeenCalledWith(
      'Leaving out an MCP server that cannot start',
      expect.objectContaining({ name: 'gone', reason: expect.stringContaining('missing') })
    );
  });
});
