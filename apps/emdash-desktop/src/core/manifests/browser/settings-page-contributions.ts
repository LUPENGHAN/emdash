import { continueWritingSettingsPage } from '@core/features/conversations/contributions/settings-page';
import { promptsSettingsPage } from '@core/features/library/contributions/settings-page';
import {
  conversationsSettingsPage,
  localWorkspacesSettingsPage,
  machinesConnectionsPage,
  systemSettingsPage,
} from '@core/features/machines/contributions/settings-page';
import { mcpSettingsPage } from '@core/features/mcp/contributions/settings-page';
import { decisionsSettingsPage } from '@core/features/memory/contributions/settings-page';
import { providersSettingsPage } from '@core/features/model-providers/contributions/settings-page';
import { remoteAccessSettingsPage } from '@core/features/remote-access/contributions/settings-page';
import {
  agentsSettingsPage,
  browserSettingsPage,
  generalSettingsPage,
  integrationsSettingsPage,
  interfaceSettingsPage,
  repositorySettingsPage,
} from '@core/features/settings/contributions/settings-pages';
import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import { skillsSettingsPage } from '@core/features/skills/contributions/settings-page';
import { usageSettingsPage } from '@core/features/usage/contributions/settings-page';
import type { SettingsPageContribution } from '@core/primitives/settings/api/page-contribution';

export const settingsPageContributions = [
  generalSettingsPage,
  decisionsSettingsPage,
  integrationsSettingsPage,
  interfaceSettingsPage,
  browserSettingsPage,
  repositorySettingsPage,
  promptsSettingsPage,
  usageSettingsPage,
  continueWritingSettingsPage,
  systemSettingsPage,
  localWorkspacesSettingsPage,
  conversationsSettingsPage,
  agentsSettingsPage,
  providersSettingsPage,
  mcpSettingsPage,
  skillsSettingsPage,
  machinesConnectionsPage,
  remoteAccessSettingsPage,
] as const satisfies readonly SettingsPageContribution<Exclude<SettingsPageTab, 'docs'>>[];
