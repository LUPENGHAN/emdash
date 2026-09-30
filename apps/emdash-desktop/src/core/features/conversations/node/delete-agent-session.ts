import { execFile } from 'node:child_process';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ImportableSession } from '@core/primitives/conversations/api';
import { cursorHome } from './cursor-sessions';
import {
  listFilesRecursive,
  parseJsonLines,
  piSessionsDir,
  type ExternalSessionEnv,
} from './external-sessions';

const execFileAsync = promisify(execFile);

export type DeleteAgentSessionDeps = {
  env?: ExternalSessionEnv;
  /** Moves a file or folder to the system trash. */
  trash: (target: string) => Promise<void>;
  /** Runs `opencode <args>`; OpenCode keeps sessions in its own database. */
  runOpenCode?: (args: string[]) => Promise<void>;
};

/**
 * Removes a session from the agent's own history, so neither the agent (`--resume`,
 * its session pickers) nor Emdash's History lists it again. Session files go to the
 * system trash; OpenCode deletes the session from its database itself. Returns how
 * many files or records were removed; zero means nothing was saved under that id.
 */
export async function deleteAgentSession(
  providerId: ImportableSession['providerId'],
  sessionId: string,
  deps: DeleteAgentSessionDeps
): Promise<number> {
  const env = deps.env ?? { home: homedir(), env: process.env };
  // Pi-family terminal sessions used to be recorded by their file's path: take the id
  // from that file, when it is one of the agent's own session files.
  if ((providerId === 'pi' || providerId === 'oh-my-pi') && path.isAbsolute(sessionId)) {
    const root = piSessionsDir(providerId, env);
    const inside = path.relative(root, sessionId);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) {
      sessionId = (await piSessionId(sessionId)) ?? sessionId;
    }
  }
  // Ids name files below: never let one climb out of the agent's folders.
  if (!/^[\w.-]+$/.test(sessionId) || sessionId.startsWith('.')) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const targets = await sessionPaths(providerId, sessionId, env, deps);
  for (const target of targets) await deps.trash(target);
  return targets.length;
}

async function sessionPaths(
  providerId: ImportableSession['providerId'],
  sessionId: string,
  env: ExternalSessionEnv,
  deps: DeleteAgentSessionDeps
): Promise<string[]> {
  switch (providerId) {
    case 'claude': {
      // <projects>/<cwd folder>/<id>.jsonl, plus <id>/ with its sub-agent transcripts.
      const projects = path.join(
        env.env.CLAUDE_CONFIG_DIR ?? path.join(env.home, '.claude'),
        'projects'
      );
      const found: string[] = [];
      for (const folder of await listDirs(projects)) {
        for (const name of [`${sessionId}.jsonl`, sessionId]) {
          const candidate = path.join(projects, folder, name);
          if (await exists(candidate)) found.push(candidate);
        }
      }
      return found;
    }
    case 'codex': {
      // rollout-<time>-<id>.jsonl, live or archived.
      const codexHome = env.env.CODEX_HOME ?? path.join(env.home, '.codex');
      const files = [
        ...(await listFilesRecursive(path.join(codexHome, 'sessions'), '.jsonl')),
        ...(await listFilesRecursive(path.join(codexHome, 'archived_sessions'), '.jsonl')),
      ];
      return files.filter((file) => path.basename(file, '.jsonl').endsWith(sessionId));
    }
    case 'pi':
    case 'oh-my-pi': {
      // File names vary by fork; the session header holds the id.
      const found: string[] = [];
      for (const file of await listFilesRecursive(piSessionsDir(providerId, env), '.jsonl')) {
        if ((await piSessionId(file)) === sessionId) found.push(file);
      }
      return found;
    }
    case 'cursor': {
      const root = cursorHome(env);
      const found: string[] = [];
      const chatUi = path.join(root, 'acp-sessions', sessionId);
      if (await exists(chatUi)) found.push(chatUi);
      for (const bucket of await listDirs(path.join(root, 'chats'))) {
        const terminal = path.join(root, 'chats', bucket, sessionId);
        if (await exists(terminal)) found.push(terminal);
      }
      return found;
    }
    case 'opencode': {
      const run =
        deps.runOpenCode ??
        (async (args: string[]) => {
          await execFileAsync('opencode', args, { timeout: 30_000 });
        });
      await run(['session', 'delete', sessionId]);
      return [];
    }
  }
}

/** A Pi / Oh My Pi session file's id, from its `session` header record. */
export async function piSessionId(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const record of parseJsonLines(buffer.subarray(0, bytesRead).toString('utf8'))) {
      if (record.type === 'session') return typeof record.id === 'string' ? record.id : null;
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pi and Oh My Pi terminal sessions used to be recorded by their session file's path;
 * their chat adapters only take the session id (the file's header id, which can
 * differ from the one in its name). A local path is read for its id; anything else
 * is returned as stored.
 */
export async function piFamilySessionId(
  providerId: string | null,
  sessionId: string | null
): Promise<string | null> {
  if (providerId !== 'pi' && providerId !== 'oh-my-pi') return sessionId;
  if (!sessionId || !path.isAbsolute(sessionId) || !sessionId.endsWith('.jsonl')) {
    return sessionId;
  }
  return (await piSessionId(sessionId)) ?? sessionId;
}
