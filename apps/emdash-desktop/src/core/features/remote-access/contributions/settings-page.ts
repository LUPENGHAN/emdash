import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { RemoteAccessSettingsPage } from '../browser/remote-access-settings-page';

export const remoteAccessSettingsPage = defineSettingsPageContribution({
  id: 'remote-access',
  label: 'Remote access',
  icon: 'monitor-smartphone',
  component: RemoteAccessSettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
