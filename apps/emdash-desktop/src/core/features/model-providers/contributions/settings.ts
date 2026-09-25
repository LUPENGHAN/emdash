import { defineSettingsContribution } from '@core/primitives/settings/api';
import { modelProvidersSettingsSchema, type ModelProvidersSettings } from '../api';

export const modelProvidersSettingsContribution = defineSettingsContribution<
  'modelProviders',
  ModelProvidersSettings
>({
  key: 'modelProviders',
  schema: modelProvidersSettingsSchema,
  defaults: { providers: [] },
});
