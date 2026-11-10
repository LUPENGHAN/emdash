import type { PortableRelativePath } from '#primitives/path/api';
import { toRefString, type GitFileContentState, type GitFileSource } from '#runtimes/git/api';
import { checkoutFailures } from '#runtimes/git/node/checkout/errors';
import { commandFailed, gitFailure, isMissingObject } from '#runtimes/git/node/exec/errors';
import type { BoundExec } from '#services/exec/api';

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

export async function readGitFileContent(
  exec: BoundExec,
  path: PortableRelativePath,
  source: GitFileSource,
  signal?: AbortSignal
): Promise<GitFileContentState> {
  const spec = sourceSpec(source, path);
  let oid: string;
  try {
    const { stdout: oidOutput } = await exec.exec(
      ['rev-parse', '--verify', '--end-of-options', spec],
      { signal }
    );
    oid = oidOutput.trim();
  } catch (error) {
    if (await isMissingGitContent(exec, error, source, path, signal)) {
      return { kind: 'missing', path, source };
    }
    return { kind: 'unavailable', path, source, error: commandFailed(error).error };
  }
  try {
    const { stdout } = await exec.execBuffer(['cat-file', 'blob', oid], {
      maxBuffer: MAX_CONTENT_BYTES,
      signal,
    });
    const base = { path, source, oid, byteSize: stdout.length } as const;
    if (stdout.includes(0)) return { kind: 'binary', ...base };
    try {
      return {
        kind: 'text',
        ...base,
        content: new TextDecoder('utf-8', { fatal: true }).decode(stdout),
      };
    } catch {
      return { kind: 'binary', ...base };
    }
  } catch (error) {
    return { kind: 'unavailable', path, source, error: commandFailed(error).error };
  }
}

/** True when a failed object read means "no blob at this path/source" rather than a git error. */
export async function isMissingGitContent(
  exec: BoundExec,
  error: unknown,
  source: GitFileSource,
  path: PortableRelativePath,
  signal?: AbortSignal
): Promise<boolean> {
  const failure = gitFailure(error);
  const missing =
    isMissingObject(failure) ||
    (failure.exitCode === 128 &&
      failure.message.toLowerCase().includes('needed a single revision')) ||
    checkoutFailures.isUnknownRevision(error) ||
    (source.kind === 'index' && checkoutFailures.isMissingIndexEntry(error));
  if (
    !missing ||
    source.kind !== 'revision' ||
    source.revision.kind !== 'commit' ||
    !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(source.revision.sha)
  )
    return missing;
  const ref = toRefString(source.revision);
  try {
    const { stdout } = await exec.exec(
      ['ls-tree', '-z', '--full-tree', ref, '--', `:(literal)${path}`],
      { signal }
    );
    return stdout.length === 0;
  } catch (verifyError) {
    gitFailure(verifyError);
    return false;
  }
}

export function sourceSpec(source: GitFileSource, path: PortableRelativePath): string {
  switch (source.kind) {
    case 'head':
      return `HEAD:${path}`;
    case 'index':
      return `:${path}`;
    case 'revision':
      return `${toRefString(source.revision)}:${path}`;
  }
}
