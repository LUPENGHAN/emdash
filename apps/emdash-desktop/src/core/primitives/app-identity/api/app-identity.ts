type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';
// A locally built fork: its own bundle id, profile and keychain item, so it can run
// next to (or instead of) the official app without sharing signed-app secrets.
const isFork = env?.VITE_BUILD === 'fork';

export const APP_ID = isFork
  ? 'com.emdash.fork'
  : isCanary
    ? 'com.emdash.canary'
    : 'com.emdash.stable';
export const PRODUCT_NAME = isFork ? 'Emdash Fork' : isCanary ? 'Emdash Canary' : 'Emdash';
export const APP_NAME_LOWER = isFork ? 'emdash-fork' : isCanary ? 'emdash-canary' : 'emdash';
export const LINUX_DESKTOP_ID = isFork ? 'emdash-fork' : isCanary ? 'emdash-canary' : 'Emdash';
export const USER_DATA_DIR_NAME = isDev
  ? 'emdash-dev'
  : isFork
    ? 'emdash-fork'
    : isCanary
      ? 'emdash-canary'
      : 'emdash';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isFork ? 'emdash-fork' : isCanary ? 'emdash-canary' : 'emdash';
export const R2_BASE_URL = 'https://releases.emdash.sh';
export const IS_CANARY = isCanary;
/** Fork builds never auto-update: official releases would replace the fork's changes. */
export const IS_FORK = isFork;
