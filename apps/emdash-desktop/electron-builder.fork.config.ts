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
};

export default config;
