import type { Configuration } from 'electron-builder';
import base from './electron-builder.config.ts';

// Local fork build: pair with `VITE_BUILD=fork` at build time so the runtime identity
// (bundle id, profile directory, keychain item) matches. Never published or updated.
const PRODUCT_NAME = 'Emdash Fork';

const config: Configuration = {
  ...base,
  appId: 'com.emdash.fork',
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  artifactName: 'emdash-fork-${arch}.${ext}',
  publish: null,
  // Windows: one installer the install script runs silently (`/S`) for this user,
  // unsigned (the official build's Azure signing is not ours to use).
  win: {
    ...base.win,
    target: [{ target: 'nsis', arch: ['x64'] }],
    azureSignOptions: undefined,
  },
  nsis: {
    ...base.nsis,
    // Not one-click: only this installer names the folder after the product
    // ("Emdash Fork"); a one-click one takes the package name, "@emdashemdash-desktop",
    // and the packaged app cannot load its own modules from a path with "@" in it.
    oneClick: false,
    perMachine: false,
    differentialPackage: false,
  },
};

export default config;
