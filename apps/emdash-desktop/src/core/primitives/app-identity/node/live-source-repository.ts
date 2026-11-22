import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { IS_LIVE } from '../api/app-identity';

export const LIVE_SOURCE_REPOSITORY_PROTECTED_MESSAGE =
  '实时开发版正在从这个仓库运行。它是唯一的 Emdash 自修改仓库，不能删除、归档或创建分支工作区。';

function resolvedLocalPath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    canonical = resolve(path);
  }
  return canonical;
}

function localPathIdentity(path: string): string {
  const resolved = resolvedLocalPath(path);
  return process.platform === 'darwin' || process.platform === 'win32'
    ? resolved.toLocaleLowerCase('en-US')
    : resolved;
}

/**
 * Returns the supervisor-owned source checkout only for the source-running Live build.
 * A packaged release/fork has neither the Live build identity nor this injected path,
 * so this capability is closed by default.
 */
export function getLiveSourceRepositoryPath(
  env: NodeJS.ProcessEnv = process.env,
  isLive: boolean = IS_LIVE
): string | undefined {
  if (!isLive || env.VITE_BUILD !== 'live') return undefined;
  const sourcePath = env.EMDASH_LIVE_SOURCE_PATH?.trim();
  return sourcePath ? resolvedLocalPath(sourcePath) : undefined;
}

export function isLiveSourceRepository(
  input: { hostType: 'local' | 'remote'; path: string | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
  isLive: boolean = IS_LIVE
): boolean {
  const liveSourcePath = getLiveSourceRepositoryPath(env, isLive);
  return (
    liveSourcePath !== undefined &&
    input.hostType === 'local' &&
    typeof input.path === 'string' &&
    localPathIdentity(input.path) === localPathIdentity(liveSourcePath)
  );
}
