import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { LaunchMcpServer } from '../api';

const execFileAsync = promisify(execFile);

/** OMP discovers this project file; `.omp/.mcp.json` is a lower-priority fallback. */
export const OMP_MCP_CONFIG_RELATIVE_PATH = '.omp/mcp.json';

/**
 * OMP expands `${VAR}` in MCP configs. The URL is different for every conversation,
 * so the file holds the variable and each process supplies its own value.
 */
const EMDASH_MCP_URL = '${EMDASH_MCP_URL}';

export type OmpMcpWriteResult =
  | { status: 'written' }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string };

/**
 * Gives an Oh My Pi terminal the MCP servers an Emdash launch was given. OMP reads MCP
 * only from config files, so this owns `.omp/mcp.json`: it merges the servers into any
 * user config and leaves a tracked file alone rather than dirtying the repository.
 */
export async function writeOmpMcpConfig(
  workspacePath: string,
  servers: readonly LaunchMcpServer[]
): Promise<OmpMcpWriteResult> {
  if (servers.length === 0) return { status: 'unchanged' };
  if (await isTracked(workspacePath)) {
    return { status: 'skipped', reason: `${OMP_MCP_CONFIG_RELATIVE_PATH} is tracked by git` };
  }

  const file = path.resolve(workspacePath, OMP_MCP_CONFIG_RELATIVE_PATH);
  const dir = path.dirname(file);
  const relativeDir = path.dirname(OMP_MCP_CONFIG_RELATIVE_PATH);
  let dirStats: Stats | undefined;
  try {
    dirStats = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'skipped', reason: `cannot inspect ${relativeDir}` };
    }
  }
  if (dirStats?.isSymbolicLink()) {
    return { status: 'skipped', reason: `${relativeDir} is a symlink` };
  }
  if (dirStats && !dirStats.isDirectory()) {
    return { status: 'skipped', reason: `${relativeDir} is not a directory` };
  }

  let stats: Stats | undefined;
  try {
    stats = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'skipped', reason: `cannot inspect ${OMP_MCP_CONFIG_RELATIVE_PATH}` };
    }
  }
  if (stats?.isSymbolicLink()) {
    return { status: 'skipped', reason: `${OMP_MCP_CONFIG_RELATIVE_PATH} is a symlink` };
  }

  const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const parsed = parseConfig(current);
  if ('reason' in parsed) return { status: 'skipped', reason: parsed.reason };

  const nextServers = { ...parsed.mcpServers };
  for (const server of servers) {
    nextServers[server.name] =
      server.name === 'emdash' ? { type: 'http', url: EMDASH_MCP_URL } : configForServer(server);
  }
  const text = `${JSON.stringify({ ...parsed.root, mcpServers: nextServers }, null, 2)}\n`;

  if (current === text) {
    if (stats && (stats.mode & 0o777) !== 0o600) await chmod(file, 0o600);
    return { status: 'unchanged' };
  }

  await mkdir(dir, { recursive: true });
  // The file can carry stdio env and HTTP headers; a unique temp file keeps a concurrent
  // reader from seeing a partial write.
  const temp = path.join(dir, `.mcp.json.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { status: 'written' };
}

/** Preserves unknown keys while rejecting arrays and other non-object JSON values. */
const jsonObject = z.object({}).passthrough();

function parseConfig(
  current: string | null
): { root: Record<string, unknown>; mcpServers: Record<string, unknown> } | { reason: string } {
  if (current === null || current.trim() === '') return { root: {}, mcpServers: {} };

  let json: unknown;
  try {
    json = JSON.parse(current);
  } catch {
    return { reason: `${OMP_MCP_CONFIG_RELATIVE_PATH} is not valid JSON` };
  }
  const root = jsonObject.safeParse(json);
  if (!root.success) {
    return { reason: `${OMP_MCP_CONFIG_RELATIVE_PATH} does not contain a JSON object` };
  }

  const mcpServers = root.data.mcpServers;
  if (mcpServers === undefined) return { root: root.data, mcpServers: {} };
  const servers = jsonObject.safeParse(mcpServers);
  if (!servers.success) {
    return { reason: `${OMP_MCP_CONFIG_RELATIVE_PATH} has a non-object mcpServers value` };
  }
  return { root: root.data, mcpServers: servers.data };
}

function configForServer(server: LaunchMcpServer): Record<string, unknown> {
  if (server.transport === 'http') {
    return {
      type: 'http',
      url: server.url ?? '',
      ...(server.headers && { headers: server.headers }),
    };
  }
  return {
    type: 'stdio',
    command: server.command ?? '',
    ...(server.args && { args: server.args }),
    ...(server.env && { env: server.env }),
  };
}

async function isTracked(workspacePath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['ls-files', '--error-unmatch', '--', OMP_MCP_CONFIG_RELATIVE_PATH],
      { cwd: workspacePath }
    );
    return true;
  } catch {
    // Not tracked, not a Git repository, or Git is unavailable: writing is safe either way.
    return false;
  }
}
