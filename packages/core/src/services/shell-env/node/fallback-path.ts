import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where CLIs are commonly installed on macOS/Linux, beyond the bare launchd PATH a GUI
 * app inherits (`/usr/bin:/bin:/usr/sbin:/sbin`).
 */
export function commonCliDirectories(home: string = os.homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'bin'),
  ];
}

/**
 * When the login-shell probe fails (e.g. it times out while macOS waits on a privacy
 * prompt a shell startup file triggered), agents would otherwise resolve against the
 * bare GUI PATH and look "missing". Append the common CLI directories that exist.
 */
export function withFallbackPath(
  env: Record<string, string | undefined>,
  options: { platform?: NodeJS.Platform; home?: string; exists?: (dir: string) => boolean } = {}
): void {
  if ((options.platform ?? process.platform) === 'win32') return;
  const exists = options.exists ?? existsSync;
  const entries = (env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of commonCliDirectories(options.home)) {
    if (!entries.includes(dir) && exists(dir)) entries.push(dir);
  }
  env.PATH = entries.join(':');
}
