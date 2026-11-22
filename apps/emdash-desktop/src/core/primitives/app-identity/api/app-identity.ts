type ImportMetaWithEnv = ImportMeta & {
  env?: {
    DEV?: boolean;
    VITE_BUILD?: string;
    VITE_FORK_VERSION?: string;
    VITE_LIVE_REVISION?: string;
  };
};

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';
// The source-running macOS channel. It has a durable identity and profile of its
// own, but deliberately never participates in the packaged-app updater.
const isLive = env?.VITE_BUILD === 'live';
// A locally built fork: its own bundle id, profile and keychain item, so it can run
// next to (or instead of) the official app without sharing signed-app secrets.
const isFork = env?.VITE_BUILD === 'fork';

export const APP_ID = isLive
  ? 'com.emdash.live'
  : isFork
    ? 'com.emdash.fork'
    : isCanary
      ? 'com.emdash.canary'
      : 'com.emdash.stable';
export const PRODUCT_NAME = isLive
  ? 'Emdash 实时开发版'
  : isFork
    ? 'Emdash Fork'
    : isCanary
      ? 'Emdash Canary'
      : 'Emdash';
export const APP_NAME_LOWER = isLive
  ? 'emdash-live'
  : isFork
    ? 'emdash-fork'
    : isCanary
      ? 'emdash-canary'
      : 'emdash';
export const LINUX_DESKTOP_ID = isLive
  ? 'emdash-live'
  : isFork
    ? 'emdash-fork'
    : isCanary
      ? 'emdash-canary'
      : 'Emdash';
export const USER_DATA_DIR_NAME = isLive
  ? 'emdash-live'
  : isDev
    ? 'emdash-dev'
    : isFork
      ? 'emdash-fork'
      : isCanary
        ? 'emdash-canary'
        : 'emdash';
export const UPDATE_CHANNEL = isLive ? 'disabled' : isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isLive
  ? 'emdash-live'
  : isFork
    ? 'emdash-fork'
    : isCanary
      ? 'emdash-canary'
      : 'emdash';
export const R2_BASE_URL = 'https://releases.emdash.sh';
export const IS_CANARY = isCanary;
/** Live builds are source-run and are advanced by their supervisor, never electron-updater. */
export const IS_LIVE = isLive;
/** Fork builds never auto-update: official releases would replace the fork's changes. */
export const IS_FORK = isFork;

/**
 * The fork's own build number, stamped by its install script: `fork.<commits on top of
 * the official release> (<commit>)`. Absent from official builds.
 */
export const FORK_VERSION = isFork ? env?.VITE_FORK_VERSION || undefined : undefined;
export const LIVE_REVISION = isLive ? env?.VITE_LIVE_REVISION || undefined : undefined;

/** The version as shown to people: the official one, plus the fork's build when a fork. */
export function displayVersion(version: string): string {
  if (LIVE_REVISION) return `${version} · live ${LIVE_REVISION}`;
  return FORK_VERSION ? `${version} · ${FORK_VERSION}` : version;
}
