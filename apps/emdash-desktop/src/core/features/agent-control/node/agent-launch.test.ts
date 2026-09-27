import { describe, expect, it } from 'vitest';
import { terminalLaunchForAgentControl } from './agent-launch';
import { mcpPath, verifyMcpPath } from './caller-tokens';

const URL = 'http://127.0.0.1:47821/mcp/conv/sig';

describe('terminalLaunchForAgentControl', () => {
  it('gives Claude one --mcp-config=… argument', () => {
    const launch = terminalLaunchForAgentControl('claude', URL, {})!;
    expect(launch.args).toHaveLength(1);
    const [flag, json] = launch.args[0]!.split(/=(.*)/s);
    expect(flag).toBe('--mcp-config');
    expect(JSON.parse(json!)).toEqual({ mcpServers: { emdash: { type: 'http', url: URL } } });
  });

  it('gives Codex a TOML override', () => {
    expect(terminalLaunchForAgentControl('codex', URL, {})!.args).toEqual([
      '-c',
      `mcp_servers.emdash.url="${URL}"`,
    ]);
  });

  it('merges into an existing inline OpenCode config', () => {
    const existing = JSON.stringify({ provider: { gw: { name: 'new-api' } }, mcp: { other: {} } });
    const launch = terminalLaunchForAgentControl('opencode', URL, {
      OPENCODE_CONFIG_CONTENT: existing,
    })!;
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      provider: { gw: { name: 'new-api' } },
      mcp: { other: {}, emdash: { type: 'remote', url: URL, enabled: true } },
    });
  });

  it('leaves agents without MCP alone', () => {
    expect(terminalLaunchForAgentControl('pi', URL, {})).toBeNull();
    expect(terminalLaunchForAgentControl('cursor', URL, {})).toBeNull();
  });
});

describe('caller tokens', () => {
  const secret = Buffer.from('s');
  it('round-trips and rejects another conversation’s signature', () => {
    expect(verifyMcpPath(secret, mcpPath(secret, 'conv-1'))).toBe('conv-1');
    const other = mcpPath(secret, 'conv-2').split('/').at(-1);
    expect(verifyMcpPath(secret, `/mcp/conv-1/${other}`)).toBeNull();
    expect(verifyMcpPath(Buffer.from('x'), mcpPath(secret, 'conv-1'))).toBeNull();
  });
});
