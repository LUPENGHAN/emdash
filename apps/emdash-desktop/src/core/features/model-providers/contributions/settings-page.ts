import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { ProvidersSettingsPage } from '../browser/providers-settings-page';

export const providersSettingsPage = defineSettingsPageContribution({
  id: 'providers',
  label: '模型与路由',
  icon: 'network',
  component: ProvidersSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
