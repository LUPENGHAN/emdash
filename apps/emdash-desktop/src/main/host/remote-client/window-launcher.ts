import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { app } from 'electron';
import type { RemoteServer } from '@core/features/remote-access/api';

/** Hands a new window the computer it opens on, and that computer's sign-in. */
const WINDOW_SERVER_ENV = 'EMDASH_REMOTE_WINDOW';
/** Tells a window opened for another computer where the main window's profile is. */
const MAIN_PROFILE_ENV = 'EMDASH_MAIN_USER_DATA_DIR';

export type WindowServer = { server: RemoteServer; token: string };

/** Marks the page of a window opened for another computer (it skips onboarding). */
export const COMPUTER_WINDOW_QUERY = 'computer-window';

/**
 * The computer this window was opened for, if any. Read (and removed from the
 * environment) as this module loads, before any worker or agent process is started, so
 * none of them inherits the sign-in.
 */
const windowServer: WindowServer | null = (() => {
  const raw = process.env[WINDOW_SERVER_ENV];
  delete process.env[WINDOW_SERVER_ENV];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WindowServer;
    return parsed.server?.id && parsed.server.baseUrl && parsed.token ? parsed : null;
  } catch {
    return null;
  }
})();

export function takeWindowServer(): WindowServer | null {
  return windowServer;
}

/** The main window's profile: this one, unless this window was opened for a computer. */
function mainProfile(): string {
  return process.env[MAIN_PROFILE_ENV] ?? app.getPath('userData');
}

/**
 * Starts another instance of this app. For a computer, on that computer's own profile
 * (a sibling of the main one, so it keeps its own state and its own single-instance
 * lock), connecting to it; an instance already open on it just comes to the front.
 * Without one, the main window on the main profile, which likewise comes to the front
 * when it is already running.
 */
export async function launchAppWindow(target: WindowServer | null): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const main = mainProfile();
  if (target) {
    env.EMDASH_USER_DATA_DIR = join(`${main}-windows`, target.server.id);
    env[MAIN_PROFILE_ENV] = main;
    env[WINDOW_SERVER_ENV] = JSON.stringify(target);
  } else {
    env.EMDASH_USER_DATA_DIR = main;
    delete env[MAIN_PROFILE_ENV];
    delete env[WINDOW_SERVER_ENV];
  }
  // A packaged app is its own entry; a development build runs Electron on the app path.
  const args = app.isPackaged ? [] : [app.getAppPath()];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
