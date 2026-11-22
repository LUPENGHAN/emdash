import { describe, expect, it } from 'vitest';
import { getLiveSourceRepositoryPath, isLiveSourceRepository } from './live-source-repository';

describe('live source repository identity', () => {
  const liveEnv = {
    VITE_BUILD: 'live',
    EMDASH_LIVE_SOURCE_PATH: '/tmp/emdash/../emdash',
  };

  it('is unavailable outside the Live build even when an environment variable is present', () => {
    expect(getLiveSourceRepositoryPath(liveEnv, false)).toBeUndefined();
    expect(getLiveSourceRepositoryPath({ ...liveEnv, VITE_BUILD: 'fork' }, true)).toBeUndefined();
  });

  it('matches only the local supervisor-owned source checkout', () => {
    expect(isLiveSourceRepository({ hostType: 'local', path: '/tmp/emdash' }, liveEnv, true)).toBe(
      true
    );
    expect(isLiveSourceRepository({ hostType: 'remote', path: '/tmp/emdash' }, liveEnv, true)).toBe(
      false
    );
    expect(isLiveSourceRepository({ hostType: 'local', path: '/tmp/other' }, liveEnv, true)).toBe(
      false
    );
  });
});
