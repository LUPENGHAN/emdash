import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { HostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { app, type BrowserWindow } from 'electron';
import { desktopHostEvents } from '@core/features/workbench/node';
import { mainProfile } from '@main/host/remote-client/window-launcher';
import { getActiveSessionSummary } from '@main/host/sessions/active-session-summary';
import { updateService } from '@main/host/updates/update-service';
import { createShutdownCoordinator } from './coordinator';
import { runQuitCleanup } from './phases';

let sessionSummarySource:
  | { runtimes: RuntimeBroker; attachedHosts: () => readonly HostRef[] }
  | undefined;

const shutdownCoordinator = createShutdownCoordinator({
  emit: (event) => desktopHostEvents.emit(undefined, event),
  getActiveSessionSummary: () => {
    if (!sessionSummarySource) {
      throw new Error('Shutdown runtime clients have not been configured');
    }
    return getActiveSessionSummary(
      sessionSummarySource.runtimes,
      sessionSummarySource.attachedHosts()
    );
  },
  isInstallRequested: () => updateService.isInstallRequested || installScriptRequested(),
  runCleanup: runQuitCleanup,
  exit: (code) => app.exit(code),
});

/**
 * A local install script (the fork's scripts/fork/install-local.sh) leaves this file in the
 * main profile just before quitting the app to replace it, once the user has agreed to
 * stop what runs in it. The quit then skips the confirmation, as an update install does;
 * every instance (other computers' windows too) reads the main profile's file.
 */
const INSTALL_QUIT_MARKER = 'quit-for-install';
const INSTALL_QUIT_MARKER_MAX_AGE_MS = 2 * 60_000;
let installScriptQuit = false;

function installScriptRequested(): boolean {
  if (installScriptQuit) return true;
  try {
    const { mtimeMs } = statSync(join(mainProfile(), INSTALL_QUIT_MARKER));
    installScriptQuit = Date.now() - mtimeMs < INSTALL_QUIT_MARKER_MAX_AGE_MS;
  } catch {
    // No install is waiting on this quit.
  }
  return installScriptQuit;
}

let registered = false;

export function configureShutdownRuntimeClients(
  runtimes: RuntimeBroker,
  attachedHosts: () => readonly HostRef[]
): void {
  sessionSummarySource = { runtimes, attachedHosts };
}

export function registerQuitHandler(): void {
  if (registered) return;
  registered = true;
  app.on('before-quit', (event) => {
    event.preventDefault();
    void shutdownCoordinator.handleQuitRequested();
  });
}

export function resolveQuitConfirmation(requestId: string, confirmed: boolean): void {
  shutdownCoordinator.resolveQuitConfirmation(requestId, confirmed);
}

export function ackShutdownFlush(): void {
  shutdownCoordinator.ackShutdownFlush();
}

export function markShutdownReady(): void {
  shutdownCoordinator.markShutdownReady();
}

export function watchWindow(window: BrowserWindow): void {
  shutdownCoordinator.watchWindow(window);
}

export function isShutdownInProgress(): boolean {
  return shutdownCoordinator.isShutdownInProgress();
}

export function shouldAllowWindowClose(): boolean {
  return shutdownCoordinator.state === 'shutting-down' || updateService.isInstallRequested;
}

export { createShutdownCoordinator, runQuitCleanup };
export type {
  QuitState,
  ShutdownCoordinator,
  ShutdownCoordinatorDependencies,
} from './coordinator';
