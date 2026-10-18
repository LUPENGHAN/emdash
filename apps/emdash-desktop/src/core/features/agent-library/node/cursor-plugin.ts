import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LaunchMcpServer } from '../api';

/** Plugin folders older than this are from conversations long gone. */
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** A conversation id becomes a folder name; this charset cannot leave the root. */
const CONVERSATION_ID = /^[A-Za-z0-9-]+$/;

/**
 * Cursor's terminal CLI takes MCP servers only from config files or a plugin folder
 * (`--plugin-dir`), so each launch gets a folder of its own holding just `mcp.json`.
 * It can carry secrets (env, headers), so only this user can read it.
 */
export async function writeCursorPluginDir(
  root: string,
  conversationId: string,
  servers: readonly LaunchMcpServer[]
): Promise<string> {
  if (!CONVERSATION_ID.test(conversationId)) {
    throw new Error(
      `Refusing a Cursor plugin folder for conversation id ${JSON.stringify(conversationId)}`
    );
  }
  const dir = path.join(root, conversationId);
  // Every launch rewrites the folder; leftovers of an older format never linger.
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, '.cursor-plugin'), { recursive: true });
  await chmod(dir, 0o700);
  await writeFile(
    path.join(dir, '.cursor-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: 'emdash-library',
        version: '1.0.0',
        description: 'MCP servers from the Emdash library',
      },
      null,
      2
    )}\n`
  );
  const mcpFile = path.join(dir, 'mcp.json');
  await writeFile(mcpFile, `${JSON.stringify(mcpServersOf(servers), null, 2)}\n`);
  await chmod(mcpFile, 0o600);
  return dir;
}

/** Removes plugin folders not written for two weeks. Errors are ignored. */
export async function pruneCursorPluginDirs(root: string, now = Date.now()): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const stats = await stat(dir);
      if (now - stats.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true });
    } catch {
      // Deleted or unreadable meanwhile: nothing to do.
    }
  }
}

function mcpServersOf(servers: readonly LaunchMcpServer[]) {
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        server.transport === 'http'
          ? { url: server.url, ...(server.headers && { headers: server.headers }) }
          : {
              command: server.command,
              args: server.args ?? [],
              ...(server.env && { env: server.env }),
            },
      ])
    ),
  };
}
