import { describe, expect, it } from 'vitest';
import { withFallbackPath } from './fallback-path';

describe('withFallbackPath', () => {
  const existing = new Set(['/opt/homebrew/bin', '/Users/me/.local/bin', '/usr/local/bin']);
  const exists = (dir: string) => existing.has(dir);

  it('appends existing common CLI directories missing from a bare GUI PATH', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin:/bin:/usr/local/bin' };
    withFallbackPath(env, { platform: 'darwin', home: '/Users/me', exists });
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  });

  it('handles an absent PATH and leaves Windows alone', () => {
    const env: Record<string, string | undefined> = {};
    withFallbackPath(env, { platform: 'darwin', home: '/Users/me', exists });
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin');

    const windows: Record<string, string | undefined> = { PATH: 'C:\\\\bin' };
    withFallbackPath(windows, { platform: 'win32', exists });
    expect(windows.PATH).toBe('C:\\\\bin');
  });
});
