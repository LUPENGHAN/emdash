/** The MCP server name agents see Emdash's tools under. */
export const AGENT_CONTROL_SERVER_NAME = 'emdash';

export type AgentControlLaunch = { args: string[]; env: Record<string, string> };

/**
 * How a terminal-launched agent gets the Emdash MCP server: a CLI flag or config env
 * per agent. Agents without MCP support (Pi, Oh My Pi) and file-only ones (Cursor) get
 * nothing. `env` is the launch env so far, for agents configured through one variable.
 */
export function terminalLaunchForAgentControl(
  providerId: string,
  url: string,
  env: Readonly<Record<string, string>>
): AgentControlLaunch | null {
  switch (providerId) {
    case 'claude':
      // `=` keeps the variadic flag from swallowing a following prompt argument.
      return {
        args: [
          `--mcp-config=${JSON.stringify({
            mcpServers: { [AGENT_CONTROL_SERVER_NAME]: { type: 'http', url } },
          })}`,
        ],
        env: {},
      };
    case 'codex':
      return {
        args: ['-c', `mcp_servers.${AGENT_CONTROL_SERVER_NAME}.url=${JSON.stringify(url)}`],
        env: {},
      };
    case 'opencode':
      return {
        args: [],
        env: {
          OPENCODE_CONFIG_CONTENT: withOpenCodeMcp(env.OPENCODE_CONFIG_CONTENT, url),
        },
      };
    default:
      return null;
  }
}

/** Adds the Emdash server to an inline OpenCode config (which may already set a provider). */
function withOpenCodeMcp(existing: string | undefined, url: string): string {
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>;
    } catch {
      // An unparsable inline config would fail OpenCode anyway; start clean.
    }
  }
  const mcp = (config.mcp && typeof config.mcp === 'object' ? config.mcp : {}) as Record<
    string,
    unknown
  >;
  return JSON.stringify({
    ...config,
    mcp: { ...mcp, [AGENT_CONTROL_SERVER_NAME]: { type: 'remote', url, enabled: true } },
  });
}
