import { Select } from '@emdash/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { UiLanguage } from '../../api';

// Each language is named in itself, so it can be found whatever is showing.
const OPTIONS: { value: UiLanguage; label: string }[] = [
  { value: 'system', label: 'System / 跟随系统' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
];

export function LanguageCard() {
  const { value, update } = useAppSettingsKey('language');
  const current = value ?? 'system';
  return (
    <div translate="no">
      <Select.Root value={current} onValueChange={(next) => next && update(next as UiLanguage)}>
        <Select.Trigger appearance="input" className="w-60">
          <Select.Value>{OPTIONS.find((option) => option.value === current)?.label}</Select.Value>
        </Select.Trigger>
        <Select.Content align="start">
          {OPTIONS.map((option) => (
            <Select.Item key={option.value} value={option.value}>
              {option.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  );
}
