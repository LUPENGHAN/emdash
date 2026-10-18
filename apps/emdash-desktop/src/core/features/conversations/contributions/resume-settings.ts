import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export const resumeJobSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  projectId: z.string().default(''),
  taskId: z.string().default(''),
  conversationId: z.string().default(''),
  text: z.string().default('继续'),
  /** Local time `HH:mm`. Empty means no clock trigger. */
  clockTime: z.string().default(''),
  onWindowReset: z.boolean().default(false),
  /** Send a handoff when the current official account reaches this percent. */
  quotaPercent: z.number().min(1).max(100).nullable().default(null),
  confirm: z.boolean().default(false),
  /** `YYYY-MM-DD` of the last clock send, so a day fires once. */
  clockDay: z.string().nullable().default(null),
  /** Last observed usage of the conversation's login, so a drop can be told from the first reading. */
  usagePercents: z.string().nullable().default(null),
  /** Last quota handoff (`from->to`), cleared once that login is under the limit again. */
  quotaKey: z.string().nullable().default(null),
});
export type ResumeJob = z.infer<typeof resumeJobSchema>;

/** The id the single pre-list setting becomes, so its bookkeeping carries over. */
export const LEGACY_RESUME_JOB_ID = 'legacy';

/**
 * Before the list, the setting was one flat job. Stored values are a delta merged over
 * the defaults, so an old one arrives as `{ jobs: [], enabled, projectId, … }`; the
 * bookkeeping fields ride along so nothing fires twice on upgrade day. The old default
 * was off, so a delta without `enabled` was a switched-off job and must stay off.
 */
function migrateLegacyResumeWriting(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as Record<string, unknown>;
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  if (jobs.length > 0 || typeof value.conversationId !== 'string' || !value.conversationId) {
    return { jobs };
  }
  const { jobs: _jobs, ...legacy } = value;
  return {
    jobs: [{ ...legacy, enabled: legacy.enabled === true, id: LEGACY_RESUME_JOB_ID }],
  };
}

export const resumeWritingSettingsSchema = z.preprocess(
  migrateLegacyResumeWriting,
  z.object({ jobs: z.array(resumeJobSchema).default([]) })
);

export type ResumeWritingSettings = { jobs: ResumeJob[] };

export const DEFAULT_RESUME_WRITING_SETTINGS: ResumeWritingSettings = { jobs: [] };

export const resumeWritingSettingsContribution = defineSettingsContribution<
  'resumeWriting',
  ResumeWritingSettings
>({
  key: 'resumeWriting',
  schema: resumeWritingSettingsSchema,
  defaults: DEFAULT_RESUME_WRITING_SETTINGS,
});
