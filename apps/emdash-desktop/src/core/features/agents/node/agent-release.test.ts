import type { CLIAgentPluginProvider } from '@emdash/core/services/agent-plugins/api/plugins';
import { describe, expect, it } from 'vitest';
import type { Installation } from '@core/primitives/agents/api';
import {
  applyAgentRelease,
  compareVersions,
  githubRepoFromProvider,
  isNewerVersion,
  npmPackageFromCommand,
  parseVersion,
} from './agent-release';

function installation(partial: Partial<Installation> = {}): Installation {
  return {
    id: '/usr/local/lib/node_modules/pkg/bin/agent',
    realpath: '/usr/local/lib/node_modules/pkg/bin/agent',
    pathEntry: '/usr/local/bin/agent',
    isActive: true,
    manageable: false,
    provenance: { kind: 'unknown', confidence: 'inferred' },
    status: 'available',
    version: null,
    latestVersion: null,
    updateAvailable: false,
    ...partial,
  };
}

describe('agent release parsing', () => {
  it('reads a version out of a --version line', () => {
    expect(parseVersion('claude 2.1.140 (Claude Code)')).toBe('2.1.140');
    expect(parseVersion('no version here')).toBeNull();
  });

  it('treats a higher latest version as an update', () => {
    expect(isNewerVersion('2.2.0', '2.1.9')).toBe(true);
    expect(isNewerVersion('v1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion(null, '1.0.0')).toBe(false);
  });

  it('orders prereleases below their release', () => {
    expect(isNewerVersion('2.0.0', '2.0.0-beta.1')).toBe(true);
    expect(isNewerVersion('2.0.0-beta.1', '2.0.0')).toBe(false);
    expect(compareVersions('2.0.0-beta.2', '2.0.0-beta.10')).toBe(-1);
    expect(compareVersions('2.0.0-alpha', '2.0.0-beta')).toBe(-1);
    expect(compareVersions('2.0.0-1', '2.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('reads an npm package and a github repo off a plugin', () => {
    expect(npmPackageFromCommand('npm install -g @earendil-works/pi-coding-agent')).toBe(
      '@earendil-works/pi-coding-agent'
    );
    const provider = {
      capabilities: {
        hostDependency: {
          updates: { releaseSource: { kind: 'github', repo: 'can1357/oh-my-pi' } },
        },
      },
    } as unknown as CLIAgentPluginProvider;
    expect(githubRepoFromProvider(provider)).toBe('can1357/oh-my-pi');
  });
});

describe('applyAgentRelease', () => {
  const status = {
    installations: [installation()],
    version: '1.0.0',
    latestVersion: null,
    updateAvailable: false,
  };

  it('keeps the known version when --version failed', () => {
    const next = applyAgentRelease(status, {
      version: null,
      latestVersion: '1.1.0',
      method: null,
      checkedAt: 0,
    });
    expect(next).toMatchObject({ version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true });
    expect(next.installations[0]).toMatchObject({ version: '1.0.0', updateAvailable: true });
  });

  it('applies an update method only where the install agrees with it', () => {
    const release = {
      version: '1.0.0',
      latestVersion: '1.1.0',
      method: 'npm' as const,
      checkedAt: 0,
    };
    expect(applyAgentRelease(status, release).installations[0]).toMatchObject({
      manageable: true,
      provenance: { kind: 'npm' },
    });
    const brewed = {
      ...status,
      installations: [installation({ realpath: '/opt/homebrew/Cellar/agent/1.0.0/bin/agent' })],
    };
    expect(applyAgentRelease(brewed, release).installations[0]).toMatchObject({
      manageable: false,
      provenance: { kind: 'unknown' },
    });
    const manual = {
      ...status,
      installations: [installation({ provenance: { kind: 'manual', confidence: 'confirmed' } })],
    };
    expect(applyAgentRelease(manual, release).installations[0]).toMatchObject({
      manageable: false,
      provenance: { kind: 'manual' },
    });
  });
});
