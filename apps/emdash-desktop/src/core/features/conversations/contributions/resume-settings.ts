import { z } from 'zod';
import { defineSettingsContribution } from '@core/primitives/settings/api';

export const resumeWritingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
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

export type ResumeWritingSettings = z.infer<typeof resumeWritingSettingsSchema>;

export const DEFAULT_RESUME_WRITING_SETTINGS: ResumeWritingSettings = {
  enabled: false,
  projectId: '',
  taskId: '',
  conversationId: '',
  text: '继续',
  clockTime: '',
  onWindowReset: false,
  quotaPercent: null,
  confirm: false,
  clockDay: null,
  usagePercents: null,
  quotaKey: null,
};

export const resumeWritingSettingsContribution = defineSettingsContribution<
  'resumeWriting',
  ResumeWritingSettings
>({
  key: 'resumeWriting',
  schema: resumeWritingSettingsSchema,
  defaults: DEFAULT_RESUME_WRITING_SETTINGS,
});
