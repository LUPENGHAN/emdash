import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { ChartColumn } from 'lucide-react';
import { openModal } from '@core/manifests/browser/modal-api';

/** Opens the usage statistics: calls and spend across this computer and the others. */
export function UsageStatsButton() {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0 [-webkit-app-region:no-drag]"
          aria-label="Usage statistics"
          onClick={() => void openModal('usageStatsModal')}
        >
          <ChartColumn className="h-4 w-4" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>Usage statistics</Tooltip.Content>
    </Tooltip.Root>
  );
}
