import { join } from 'node:path';
import { app } from 'electron';
import { displayVersion, FORK_VERSION } from '@core/primitives/app-identity/api/app-identity';
import type { AppConfig } from '../../core/config';
import { markUserDataConfigured } from '../../core/config';

export function applyIdentity(config: AppConfig): void {
  app.setName(config.identity.productName);
  // The fork's build number in the About panel too, next to the official version.
  if (FORK_VERSION)
    app.setAboutPanelOptions({ applicationVersion: displayVersion(app.getVersion()) });
  // EMDASH_USER_DATA_DIR redirects the whole profile (DB, logs, mementos) to an
  // isolated directory — used by the boot-measurement harness and scratch profiles.
  const userDataPath =
    config.userDataDir ?? join(app.getPath('appData'), config.identity.userDataDirName);
  app.setPath('userData', userDataPath);
  markUserDataConfigured();
}
