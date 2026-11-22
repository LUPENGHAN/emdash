import { app } from 'electron';
import devIcon from '@/assets/images/emdash/emdash-dev.png?asset';
import { IS_LIVE } from '@core/primitives/app-identity/api/app-identity';
import { initializeFileLogger, registerProcessErrorLogging } from '@main/host/file-logger';
import { registerAppScheme } from '@main/host/protocol';
import { log } from '@main/lib/logger';
import type { AppConfig } from '../../core/config';
import { step } from '../../core/phase';
import { BootAborted, type BootSignals } from '../types';

export async function prepareElectron(config: AppConfig, signals: BootSignals): Promise<void> {
  registerAppScheme();
  initializeFileLogger();
  registerProcessErrorLogging(log);

  app.on('second-instance', () => {
    if (signals.windowPhaseReady) void showMainWindow();
  });

  // Ordinary development profiles may run side by side. The durable live
  // channel is different: it owns real user data and must never allow an old
  // or packaged instance to open that profile concurrently during a restart.
  if ((!config.isDev || IS_LIVE) && !app.requestSingleInstanceLock()) {
    app.quit();
    throw new BootAborted('Another application instance is already running');
  }

  if (config.isDev) {
    try {
      app.dock?.setIcon(devIcon);
    } catch (error) {
      log.warn('Failed to set dock icon:', error);
    }
  }

  app.on('activate', () => {
    if (signals.windowPhaseReady) void showMainWindow();
  });

  // Emdash remains available from the tray when its main window is destroyed.
  // Explicit quit requests are coordinated through the before-quit handler.
  app.on('window-all-closed', () => {});

  await step('electron-app-ready', () => app.whenReady());
}

async function showMainWindow(): Promise<void> {
  const windowModule = await import('@main/host/window');
  windowModule.showMainWindow();
}
