import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { LaunchMcpServer } from '../api';

export type McpLaunch = { args: string[]; env: Record<string, string> };

/**
 * How a terminal-launched agent gets extra MCP servers for one session, without
 * touching its own config: a flag or an inline config per agent. Pi has no MCP and
 * Cursor only reads config files, so they get nothing.
 */
export function terminalLaunchForMcp(
  providerId: string,
  servers: readonly LaunchMcpServer[],
  env: Readonly<Record<string, string>>
): McpLaunch | null {
  if (servers.length === 0) return null;
  switch (providerId) {
    case 'claude': {
      const mcpServers = Object.fromEntries(
        servers.map((server) => [
          server.name,
          server.transport === 'http'
            ? { type: 'http', url: server.url, ...(server.headers && { headers: server.headers }) }
            : {
                type: 'stdio',
                command: server.command,
                args: server.args ?? [],
                ...(server.env && { env: server.env }),
              },
        ])
      );
      // `=` keeps the variadic flag from swallowing a following prompt argument.
      return { args: [`--mcp-config=${JSON.stringify({ mcpServers })}`], env: {} };
    }
    case 'codex': {
      const args: string[] = [];
      for (const server of servers) {
        const key = `mcp_servers.${tomlKey(server.name)}`;
        const set = (field: string, value: string) => args.push('-c', `${key}.${field}=${value}`);
        if (server.transport === 'http') {
          set('url', tomlString(server.url ?? ''));
          if (server.headers) set('http_headers', tomlTable(server.headers));
        } else {
          set('command', tomlString(server.command ?? ''));
          set('args', `[${(server.args ?? []).map(tomlString).join(',')}]`);
          if (server.env) set('env', tomlTable(server.env));
        }
      }
      return { args, env: {} };
    }
    case 'opencode':
      return {
        args: [],
        env: { OPENCODE_CONFIG_CONTENT: withOpenCodeMcp(env.OPENCODE_CONFIG_CONTENT, servers) },
      };
    default:
      return null;
  }
}

/**
 * Why a stdio server's command cannot start in an agent session, or null when it can:
 * a relative path (it would resolve against each session's workspace; one copied from
 * a plugin or another agent's config lost the directory it was relative to) or an
 * absolute path that is not an executable file. Bare names are looked up on PATH.
 */
export async function unlaunchableReason(server: LaunchMcpServer): Promise<string | null> {
  if (server.transport !== 'stdio') return null;
  const command = server.command?.trim() ?? '';
  if (!command) return 'has no command';
  if (!command.includes('/') && !command.includes('\\')) return null;
  if (!path.isAbsolute(command)) return `runs a relative path (${command})`;
  try {
    await access(command, constants.X_OK);
    return null;
  } catch {
    return `runs a missing file (${command})`;
  }
}

/**
 * The servers a launch can start. An agent may refuse a whole session over one server
 * it cannot spawn (Oh My Pi does when restoring one), so those are left out.
 */
export async function launchableMcpServers(
  servers: readonly LaunchMcpServer[],
  warn?: (message: string, details: Record<string, unknown>) => void
): Promise<LaunchMcpServer[]> {
  const reasons = await Promise.all(servers.map(unlaunchableReason));
  return servers.filter((server, index) => {
    const reason = reasons[index];
    if (reason)
      warn?.('Leaving out an MCP server that cannot start', { name: server.name, reason });
    return !reason;
  });
}

/** ACP session MCP entries (the runtime keeps http ones only for agents that support it). */
export function acpMcpServers(servers: readonly LaunchMcpServer[]) {
  return servers.map((server) =>
    server.transport === 'http'
      ? { name: server.name, url: server.url ?? '', headers: server.headers }
      : { name: server.name, command: server.command ?? '', args: server.args, env: server.env }
  );
}

function withOpenCodeMcp(
  existing: string | undefined,
  servers: readonly LaunchMcpServer[]
): string {
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
  for (const server of servers) {
    mcp[server.name] =
      server.transport === 'http'
        ? {
            type: 'remote',
            url: server.url,
            enabled: true,
            ...(server.headers && { headers: server.headers }),
          }
        : {
            type: 'local',
            command: [server.command, ...(server.args ?? [])],
            enabled: true,
            ...(server.env && { environment: server.env }),
          };
  }
  return JSON.stringify({ ...config, mcp });
}

/** JSON strings are valid TOML basic strings. */
const tomlString = (value: string) => JSON.stringify(value);
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));
const tomlTable = (record: Record<string, string>) =>
  `{${Object.entries(record)
    .map(([key, value]) => `${tomlKey(key)}=${tomlString(value)}`)
    .join(',')}}`;
