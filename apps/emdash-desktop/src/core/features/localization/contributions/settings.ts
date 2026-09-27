import { defineSettingsContribution } from '@core/primitives/settings/api';
import { uiLanguageSchema, type UiLanguage } from '../api';

export const languageSettingsContribution = defineSettingsContribution<'language', UiLanguage>({
  key: 'language',
  schema: uiLanguageSchema,
  defaults: 'system',
});
