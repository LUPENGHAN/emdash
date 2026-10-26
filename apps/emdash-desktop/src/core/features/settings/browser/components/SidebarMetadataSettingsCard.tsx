import { SettingsCard } from '@emdash/ui/react/patterns';
import { SeparatedList, Switch } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const SidebarMetadataSettingsCard: React.FC = () => {
  const {
    value: interfaceSettings,
    update,
    isLoading,
    isSaving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');

  const busy = isLoading || isSaving;
  const showLineChanges = interfaceSettings?.showLeftSidebarLineChanges ?? true;
  const showPrStatus = interfaceSettings?.showLeftSidebarPrStatus ?? true;
  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;
  const showClaudeUsage = interfaceSettings?.showLeftSidebarClaudeUsage ?? true;
  const showCodexUsage = interfaceSettings?.showLeftSidebarCodexUsage ?? true;
  const showCursorUsage = interfaceSettings?.showLeftSidebarCursorUsage ?? true;

  return (
    <SettingsCard>
      <SeparatedList gap="1rem" direction="column">
        <SettingRow
          title="Left sidebar line changes"
          description="Show added and removed line counts for tasks in the left sidebar."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('showLeftSidebarLineChanges')}
                defaultLabel="on"
                onReset={() => resetField('showLeftSidebarLineChanges')}
                disabled={busy}
              />
              <Switch
                checked={showLineChanges}
                onCheckedChange={(checked) => update({ showLeftSidebarLineChanges: checked })}
                disabled={busy}
                aria-label="Show left sidebar line changes"
              />
            </>
          }
        />
        <SettingRow
          title="Left sidebar PR status"
          description="Show GitHub PR merge and status icons for tasks in the left sidebar."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('showLeftSidebarPrStatus')}
                defaultLabel="on"
                onReset={() => resetField('showLeftSidebarPrStatus')}
                disabled={busy}
              />
              <Switch
                checked={showPrStatus}
                onCheckedChange={(checked) => update({ showLeftSidebarPrStatus: checked })}
                disabled={busy}
                aria-label="Show left sidebar PR status"
              />
            </>
          }
        />
        <SettingRow
          title="Left sidebar timestamps"
          description="Show the relative task timestamp in the left sidebar."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('showLeftSidebarTimestamps')}
                defaultLabel="on"
                onReset={() => resetField('showLeftSidebarTimestamps')}
                disabled={busy}
              />
              <Switch
                checked={showTimestamps}
                onCheckedChange={(checked) => update({ showLeftSidebarTimestamps: checked })}
                disabled={busy}
                aria-label="Show left sidebar timestamps"
              />
            </>
          }
        />
        <SettingRow
          title="Claude usage"
          description="Show Claude subscription usage in the left sidebar."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('showLeftSidebarClaudeUsage')}
                defaultLabel="on"
                onReset={() => resetField('showLeftSidebarClaudeUsage')}
                disabled={busy}
              />
              <Switch
                checked={showClaudeUsage}
                onCheckedChange={(checked) => update({ showLeftSidebarClaudeUsage: checked })}
                disabled={busy}
                aria-label="Claude usage"
              />
            </>
          }
        />
        <SettingRow
          title="Codex usage"
          description="Show Codex subscription usage in the left sidebar."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('showLeftSidebarCodexUsage')}
                defaultLabel="on"
                onReset={() => resetField('showLeftSidebarCodexUsage')}
                disabled={busy}
              />
              <Switch
                checked={showCodexUsage}
                onCheckedChange={(checked) => update({ showLeftSidebarCodexUsage: checked })}
                disabled={busy}
                aria-label="Codex usage"
              />
            </>
          }
        />
        <SettingRow
          title="Cursor usage"
          description="Show Cursor subscription usage in the left sidebar."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('showLeftSidebarCursorUsage')}
                defaultLabel="on"
                onReset={() => resetField('showLeftSidebarCursorUsage')}
                disabled={busy}
              />
              <Switch
                checked={showCursorUsage}
                onCheckedChange={(checked) => update({ showLeftSidebarCursorUsage: checked })}
                disabled={busy}
                aria-label="Cursor usage"
              />
            </>
          }
        />
      </SeparatedList>
    </SettingsCard>
  );
};

export default SidebarMetadataSettingsCard;
