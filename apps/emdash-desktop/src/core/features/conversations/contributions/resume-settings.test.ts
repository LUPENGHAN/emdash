import { describe, expect, it } from 'vitest';
import {
  LEGACY_RESUME_JOB_ID,
  resumeWritingSettingsSchema,
  type ResumeWritingSettings,
} from './resume-settings';

describe('resumeWritingSettingsSchema migration', () => {
  it('turns the old flat setting into one job with the fixed legacy id, keeping every field', () => {
    const parsed = resumeWritingSettingsSchema.parse({
      jobs: [],
      enabled: true,
      projectId: 'p',
      taskId: 't',
      conversationId: 'c',
      text: 'go',
      clockTime: '09:00',
      onWindowReset: true,
      quotaPercent: 80,
      confirm: true,
      clockDay: '2026-10-01',
      usagePercents: 'main#5h=90',
      quotaKey: 'main->alt',
    }) as ResumeWritingSettings;
    expect(parsed.jobs).toEqual([
      {
        id: LEGACY_RESUME_JOB_ID,
        enabled: true,
        projectId: 'p',
        taskId: 't',
        conversationId: 'c',
        text: 'go',
        clockTime: '09:00',
        onWindowReset: true,
        quotaPercent: 80,
        confirm: true,
        clockDay: '2026-10-01',
        usagePercents: 'main#5h=90',
        quotaKey: 'main->alt',
      },
    ]);
  });

  it('keeps the new list format and drops leftover legacy fields', () => {
    const parsed = resumeWritingSettingsSchema.parse({
      jobs: [
        { id: 'a', conversationId: 'c1', clockDay: '2026-10-02' },
        { id: 'b', conversationId: 'c2', text: 'again' },
      ],
      enabled: true,
      conversationId: 'stale',
    }) as ResumeWritingSettings;
    expect(parsed.jobs).toEqual([
      {
        id: 'a',
        enabled: true,
        projectId: '',
        taskId: '',
        conversationId: 'c1',
        text: '继续',
        clockTime: '',
        onWindowReset: false,
        quotaPercent: null,
        confirm: false,
        clockDay: '2026-10-02',
        usagePercents: null,
        quotaKey: null,
      },
      {
        id: 'b',
        enabled: true,
        projectId: '',
        taskId: '',
        conversationId: 'c2',
        text: 'again',
        clockTime: '',
        onWindowReset: false,
        quotaPercent: null,
        confirm: false,
        clockDay: null,
        usagePercents: null,
        quotaKey: null,
      },
    ]);
  });

  it('keeps a switched-off old setting off (its delta has no `enabled`)', () => {
    const parsed = resumeWritingSettingsSchema.parse({
      jobs: [],
      projectId: 'p',
      taskId: 't',
      conversationId: 'c',
      clockTime: '09:00',
    }) as ResumeWritingSettings;
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0]?.enabled).toBe(false);
    expect(parsed.jobs[0]?.clockTime).toBe('09:00');
  });

  it('yields an empty list when the old setting named no conversation', () => {
    const parsed = resumeWritingSettingsSchema.parse({
      enabled: true,
      projectId: 'p',
      conversationId: '',
    }) as ResumeWritingSettings;
    expect(parsed.jobs).toEqual([]);
  });
});
