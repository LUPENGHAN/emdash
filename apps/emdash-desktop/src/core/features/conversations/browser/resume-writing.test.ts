import { describe, expect, it } from 'vitest';
import {
  resumeJobSchema,
  type ResumeJob,
} from '@core/features/conversations/contributions/resume-settings';
import { decideResume, type ResumeUsage } from './resume-writing';

const now = new Date(2026, 9, 10, 9, 0, 30);

function job(patch: Partial<ResumeJob>): ResumeJob {
  return resumeJobSchema.parse({
    id: 'j1',
    enabled: true,
    projectId: 'p',
    taskId: 't',
    conversationId: 'c',
    ...patch,
  });
}

const claude = (accountId: string | null, used: number): ResumeUsage => ({
  agent: 'claude',
  accountId,
  windows: [{ label: '5h', usedPercent: used }],
});

describe('decideResume', () => {
  it('sends once when the clock time arrives', () => {
    const first = decideResume({
      now,
      job: job({ clockTime: '09:00' }),
      providerId: 'claude',
      accounts: [],
    });
    expect(first).toMatchObject({
      type: 'send',
      reason: 'clock',
      patch: { clockDay: '2026-10-10' },
    });
    const again = decideResume({
      now,
      job: job({ clockTime: '09:00', clockDay: '2026-10-10' }),
      providerId: 'claude',
      accounts: [],
    });
    expect(again.type).toBe('none');
  });

  it('remembers the first usage reading, then sends when usage drops', () => {
    const base = {
      now,
      providerId: 'claude',
      modelSource: null as string | null,
      accounts: [claude(null, 80)],
      job: job({ onWindowReset: true }),
    };
    expect(decideResume(base)).toMatchObject({
      type: 'remember',
      patch: { usagePercents: 'default#5h=80' },
    });
    const reset = decideResume({
      ...base,
      accounts: [claude(null, 10)],
      job: { ...base.job, usagePercents: 'default#5h=80' },
    });
    expect(reset).toMatchObject({ type: 'send', reason: 'window-reset' });
  });

  it('does not count a failed usage check or a small drop as a reset', () => {
    const remembered = job({ onWindowReset: true, usagePercents: 'default#5h=80' });
    const empty = decideResume({
      now,
      job: remembered,
      providerId: 'claude',
      modelSource: null,
      accounts: [{ agent: 'claude', accountId: null, windows: [] }],
    });
    expect(empty.type).toBe('none');
    const small = decideResume({
      now,
      job: remembered,
      providerId: 'claude',
      modelSource: null,
      accounts: [claude(null, 70)],
    });
    expect(small.type).toBe('remember');
  });

  it('does not compare a reading from another login', () => {
    const decision = decideResume({
      now,
      job: job({ onWindowReset: true, usagePercents: 'main#5h=95' }),
      providerId: 'claude',
      modelSource: 'alt',
      accounts: [claude('alt', 5)],
    });
    expect(decision).toMatchObject({ type: 'remember', patch: { usagePercents: 'alt#5h=5' } });
  });

  it('switches to the official account with room left and forgets the old reading', () => {
    const decision = decideResume({
      now,
      job: job({ quotaPercent: 90, usagePercents: 'main#5h=95' }),
      providerId: 'claude',
      modelSource: 'main',
      accounts: [claude('main', 95), claude('alt', 20), claude('other', 40)],
    });
    expect(decision).toMatchObject({
      type: 'switch',
      accountId: 'alt',
      patch: { quotaKey: 'main->alt', usagePercents: null },
    });
  });

  it('does not switch twice from the same full login', () => {
    const decision = decideResume({
      now,
      job: job({ quotaPercent: 90, quotaKey: 'main->alt' }),
      providerId: 'claude',
      modelSource: 'main',
      accounts: [claude('main', 95), claude('alt', 20)],
    });
    expect(decision.type).toBe('none');
  });

  it('switches once a login opens up after none had room', () => {
    const decision = decideResume({
      now,
      job: job({ quotaPercent: 90, quotaKey: 'main->stuck' }),
      providerId: 'claude',
      modelSource: 'main',
      accounts: [claude('main', 95), claude('alt', 20)],
    });
    expect(decision).toMatchObject({ type: 'switch', accountId: 'alt' });
  });

  it('clears the handoff record once the login is under the limit again', () => {
    const decision = decideResume({
      now,
      job: job({ quotaPercent: 90, quotaKey: 'main->alt' }),
      providerId: 'claude',
      modelSource: 'main',
      accounts: [claude('main', 10)],
    });
    expect(decision).toMatchObject({ type: 'remember', patch: { quotaKey: null } });
  });
});
