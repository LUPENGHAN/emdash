import { defineSettingsContribution } from '@core/primitives/settings/api';
import { gatewayModelsSettingsSchema, type GatewayModelsSettings } from '../api/model-catalog';

export const gatewayModelsSettingsContribution = defineSettingsContribution<
  'gatewayModels',
  GatewayModelsSettings
>({
  key: 'gatewayModels',
  schema: gatewayModelsSettingsSchema,
  defaults: { version: 1, models: [] },
});
