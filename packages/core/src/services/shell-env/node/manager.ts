import { applyShellEnvCapture } from './apply';
import { captureShellEnv } from './capture';
import { withFallbackPath } from './fallback-path';
import { type ShellEnvLogger, type ShellEnvManager, type ShellEnvPolicy } from './types';
import { buildUserShellEnvSeed } from './user-env';

const CAPTURE_RETRIES = 3;
const CAPTURE_RETRY_DELAY_MS = 20_000;

export type CreateShellEnvManagerOptions = {
  readonly target?: NodeJS.ProcessEnv;
  readonly policy?: Partial<ShellEnvPolicy>;
  readonly baseEnvForProbe?: () => NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly logger?: ShellEnvLogger;
};

export function createShellEnvManager(options: CreateShellEnvManagerOptions = {}): ShellEnvManager {
  const target = options.target ?? process.env;
  const userEnv = stringEnv(buildUserShellEnvSeed(options.baseEnvForProbe?.() ?? target));
  let inFlight: Promise<void> | undefined;
  let captureStarted = false;
  let hasGoodSnapshot = false;
  let retriesLeft = CAPTURE_RETRIES;

  // A probe that timed out (typically on a macOS privacy prompt the user has not answered
  // yet) is retried a few times, so an answered prompt fixes the env without a restart.
  const scheduleRetry = () => {
    if (hasGoodSnapshot || retriesLeft <= 0) return;
    retriesLeft -= 1;
    setTimeout(() => void refresh(), CAPTURE_RETRY_DELAY_MS).unref?.();
  };

  const refresh = (): Promise<void> => {
    captureStarted = true;
    inFlight ??= refreshShellEnv(target, userEnv, hasGoodSnapshot, options)
      .then((succeeded) => {
        if (succeeded) hasGoodSnapshot = true;
        else scheduleRetry();
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    env: target,
    async current() {
      if (!captureStarted) await refresh();
      else await inFlight;
      return { ...userEnv };
    },
    getUserShellEnv: () => ({ ...userEnv }),
    refresh,
  };
}

async function refreshShellEnv(
  target: NodeJS.ProcessEnv,
  userEnv: Record<string, string>,
  hasGoodSnapshot: boolean,
  options: CreateShellEnvManagerOptions
): Promise<boolean> {
  const baseEnv = buildUserShellEnvSeed(options.baseEnvForProbe?.() ?? target);
  const capture = await captureShellEnv({
    baseEnv,
    timeoutMs: options.timeoutMs,
  });

  if (!capture.success) {
    options.logger?.warn?.('[shell-env] Failed to resolve login-shell env', {
      shell: capture.error.shell,
      error: capture.error.message,
    });
    if (!hasGoodSnapshot) {
      const fallback = stringEnv(baseEnv);
      withFallbackPath(fallback);
      replaceEnv(userEnv, fallback);
      withFallbackPath(target);
    }
    return false;
  }

  applyShellEnvCapture(target, capture.data, options.policy, { mergeBaseEnv: baseEnv });
  const nextUserEnv = stringEnv(baseEnv);
  applyShellEnvCapture(
    nextUserEnv,
    capture.data,
    { ...options.policy, preserveKeys: new Set() },
    { mergeBaseEnv: baseEnv }
  );
  replaceEnv(userEnv, nextUserEnv);

  options.logger?.info?.('[shell-env] Resolved shell env', {
    source: capture.data.source,
    pathEntries: target.PATH?.split(process.platform === 'win32' ? ';' : ':').length ?? 0,
  });
  return true;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function replaceEnv(target: Record<string, string>, source: Record<string, string>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}
