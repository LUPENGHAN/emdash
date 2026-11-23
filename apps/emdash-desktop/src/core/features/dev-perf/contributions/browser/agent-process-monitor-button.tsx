import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { Activity } from 'lucide-react';
import { openModal } from '@core/manifests/browser/modal-api';

export function AgentProcessMonitorButton() {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 p-0 [-webkit-app-region:no-drag]"
          aria-label="Agent 运行监控"
          onClick={() => void openModal('devProcessPanelModal')}
        >
          <Activity className="size-4" aria-hidden="true" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>Agent 运行监控</Tooltip.Content>
    </Tooltip.Root>
  );
}
