import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { ResumeWritingSettingsPage } from './browser/resume-writing-settings';

export const continueWritingSettingsPage = defineSettingsPageContribution({
  id: 'continue-writing',
  label: 'Continue writing',
  icon: 'repeat',
  component: ResumeWritingSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
