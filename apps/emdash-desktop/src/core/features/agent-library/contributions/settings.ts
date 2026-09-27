import { defineSettingsContribution } from '@core/primitives/settings/api';
import {
  agentLibrarySettingsSchema,
  DEFAULT_AGENT_LIBRARY_SETTINGS,
  type AgentLibrarySettings,
} from '../api';

export const agentLibrarySettingsContribution = defineSettingsContribution<
  'agentLibrary',
  AgentLibrarySettings
>({
  key: 'agentLibrary',
  schema: agentLibrarySettingsSchema,
  defaults: DEFAULT_AGENT_LIBRARY_SETTINGS,
});
