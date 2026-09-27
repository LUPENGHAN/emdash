import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Whether an agent has a saved session under this id, so resuming it can work.
 *
 * Claude Code only writes a session file once the first message is sent, so a session
 * started (`--session-id`) but never used cannot be resumed ("No conversation found").
 * It looks for `<id>.jsonl` in any project folder, since the folder name derives from
 * the cwd. Other agents, and anything that cannot be checked, count as resumable.
 */
export async function hasSavedSession(
  providerId: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<boolean> {
  if (providerId !== 'claude') return true;
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects');
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return true;
  }
  for (const folder of folders) {
    try {
      await access(path.join(projects, folder, `${sessionId}.jsonl`));
      return true;
    } catch {
      // Not in this project folder.
    }
  }
  return false;
}
