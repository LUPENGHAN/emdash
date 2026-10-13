import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CLIAgentPluginProvider } from '@emdash/core/services/agent-plugins/api/plugins';
import type { Installation, InstallMethod } from '@core/primitives/agents/api';

const execFileAsync = promisify(execFile);
const RELEASE_TTL_MS = 5 * 60 * 1000;

export type AgentRelease = {
  version: string | null;
  latestVersion: string | null;
  /** Install method whose update command the settings card should run. Null for a self-update. */
  method: InstallMethod | null;
  checkedAt: number;
};

const cache = new Map<string, AgentRelease>();
const inflight = new Map<string, Promise<AgentRelease>>();
const generations = new Map<string, number>();

export function clearAgentRelease(id: string): void {
  cache.delete(id);
  inflight.delete(id);
  generations.set(id, (generations.get(id) ?? 0) + 1);
}

/** The last known release, however old; pair with `loadAgentRelease` to refresh it. */
export function peekAgentRelease(id: string): AgentRelease | undefined {
  return cache.get(id);
}

export async function loadAgentRelease(
  id: string,
  binaryPath: string | null,
  provider: CLIAgentPluginProvider
): Promise<AgentRelease> {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.checkedAt <= RELEASE_TTL_MS) return cached;
  const pending = inflight.get(id);
  if (pending) return pending;
  const generation = generations.get(id) ?? 0;
  const next = probeAgentRelease(binaryPath, provider)
    .catch(
      (): AgentRelease => ({
        version: null,
        latestVersion: null,
        method: updateMethod(provider),
        checkedAt: Date.now(),
      })
    )
    .then((release) => {
      if ((generations.get(id) ?? 0) === generation) {
        cache.set(id, release);
        inflight.delete(id);
      }
      return release;
    });
  inflight.set(id, next);
  return next;
}

export function applyAgentRelease<
  T extends {
    installations: Installation[];
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
  },
>(status: T, release: AgentRelease | undefined): T {
  if (!release) return status;
  const version = release.version ?? status.version;
  const latestVersion = release.latestVersion ?? status.latestVersion;
  const updateAvailable = isNewerVersion(latestVersion, version);
  return {
    ...status,
    version,
    latestVersion,
    updateAvailable,
    installations: status.installations.map((installation) =>
      installation.isActive
        ? {
            ...installation,
            version,
            latestVersion,
            updateAvailable,
            ...(release.method && methodMatches(release.method, installation)
              ? {
                  manageable: true,
                  provenance: { kind: release.method, confidence: 'inferred' as const },
                }
              : {}),
          }
        : installation
    ),
  };
}

/**
 * Whether an install method's update command can be trusted for this binary: detection
 * agrees, or detection had no answer and the binary's location points at that method.
 */
function methodMatches(method: InstallMethod, installation: Installation): boolean {
  if (installation.provenance.kind === method) return true;
  if (installation.provenance.kind !== 'unknown') return false;
  const location = installation.realpath.replace(/\\/g, '/');
  switch (method) {
    case 'npm':
      return location.includes('/node_modules/');
    case 'homebrew':
      return /\/(?:Cellar|Caskroom|homebrew|linuxbrew)\//.test(location);
    case 'pip':
      return /\/(?:site-packages|pipx)\//.test(location);
    case 'cargo':
      return location.includes('/.cargo/');
    default:
      return false;
  }
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text)?.[1] ?? null;
}

export function isNewerVersion(latest: string | null, current: string | null): boolean {
  if (!latest || !current) return false;
  return compareVersions(latest, current) > 0;
}

/** Semver order: a prerelease sorts below its release, and build metadata is ignored. */
export function compareVersions(left: string, right: string): number {
  const a = splitVersion(left);
  const b = splitVersion(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function npmPackageFromCommand(command: string): string | null {
  return /(?:^|\s)npm(?:\.cmd)?\s+install\s+-g\s+(\S+)/.exec(command)?.[1] ?? null;
}

export function githubRepoFromProvider(provider: CLIAgentPluginProvider): string | null {
  const updates = provider.capabilities.hostDependency as {
    updates?: { releaseSource?: { kind?: string; repo?: string } };
  };
  const source = updates.updates?.releaseSource;
  return source?.kind === 'github' && source.repo ? source.repo : null;
}

function splitVersion(version: string): { core: number[]; pre: string[] } {
  const [withoutBuild = ''] = version.trim().replace(/^v/, '').split('+');
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  return {
    core: core.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : 0)),
    pre: pre ? pre.split('.') : [],
  };
}

function hostPlatform(): 'macos' | 'linux' | 'windows' {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

export function updateMethod(provider: CLIAgentPluginProvider): InstallMethod | null {
  if (provider.capabilities.hostDependency.updateCommand) return null;
  const options = provider.capabilities.hostDependency.installCommands?.[hostPlatform()] ?? [];
  return options.find((option) => option.updateCommand)?.method ?? null;
}

async function probeAgentRelease(
  binaryPath: string | null,
  provider: CLIAgentPluginProvider
): Promise<AgentRelease> {
  const [version, latestVersion] = await Promise.all([
    binaryPath ? readLocalVersion(binaryPath) : Promise.resolve(null),
    readLatestVersion(provider),
  ]);
  return {
    version,
    latestVersion,
    method: updateMethod(provider),
    checkedAt: Date.now(),
  };
}

async function readLocalVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 4000,
      windowsHide: true,
    });
    return parseVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    const stderr = (error as { stderr?: string }).stderr ?? '';
    return parseVersion(`${stdout}\n${stderr}`);
  }
}

async function readLatestVersion(provider: CLIAgentPluginProvider): Promise<string | null> {
  const repo = githubRepoFromProvider(provider);
  const options = provider.capabilities.hostDependency.installCommands?.[hostPlatform()] ?? [];
  const packages = options.flatMap((option) => npmPackageFromCommand(option.command) ?? []);
  const [fromGitHub, ...fromNpm] = await Promise.all([
    repo
      ? fetchJson(`https://api.github.com/repos/${repo}/releases/latest`).then((release) =>
          typeof release?.tag_name === 'string' ? parseVersion(release.tag_name) : null
        )
      : Promise.resolve(null),
    ...packages.map((pkg) =>
      fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}/latest`).then((latest) =>
        typeof latest?.version === 'string' ? parseVersion(latest.version) : null
      )
    ),
  ]);
  return fromGitHub ?? fromNpm.find((version) => version !== null) ?? null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'emdash',
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
