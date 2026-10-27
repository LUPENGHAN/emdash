import { PageLayout } from '@emdash/ui/react/patterns';
import type { SettingsPageTab } from '@core/features/settings/contributions/views';
import {
  defineSettingsPageContribution,
  type SettingsPageContribution,
} from '@core/primitives/settings/api/page-contribution';
import { MemoryReader } from '../browser/memory-reader';

export function GlobalMemorySettingsPage() {
  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-96 flex-col pb-6">
      <PageLayout.Header
        sticky
        draggable
        title="Decisions"
        description="Decisions that hold for every project on this Emdash."
      />
      <div className="min-h-0 flex-1">
        <MemoryReader scope={{ kind: 'global' }} />
      </div>
    </div>
  );
}

export const decisionsSettingsPage = defineSettingsPageContribution({
  id: 'decisions',
  label: 'Decisions',
  icon: 'book-open',
  component: GlobalMemorySettingsPage,
} satisfies SettingsPageContribution<SettingsPageTab>);
