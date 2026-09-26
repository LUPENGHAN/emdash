import { defineSettingsContribution } from '@core/primitives/settings/api';
import {
  DEFAULT_REMOTE_ACCESS_SETTINGS,
  remoteAccessSettingsSchema,
  type RemoteAccessSettings,
} from '../api';

export const remoteAccessSettingsContribution = defineSettingsContribution<
  'remoteAccess',
  RemoteAccessSettings
>({
  key: 'remoteAccess',
  schema: remoteAccessSettingsSchema,
  defaults: DEFAULT_REMOTE_ACCESS_SETTINGS,
});
