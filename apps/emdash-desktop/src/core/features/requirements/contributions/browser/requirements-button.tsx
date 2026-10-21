import { Badge, Button, Checkbox, Popover, Tooltip } from '@emdash/ui/react/primitives';
import { ListPlus } from 'lucide-react';
import { useState } from 'react';
import { getProjectViewStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { useRequirements } from '../../api/browser/use-requirements';
import { QuickRequirementInput } from '../../browser/quick-requirement-input';

const RECENT_OPEN = 5;

/** The title bar's quick way to note a requirement in the project and tick off open ones. */
export function RequirementsButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const { navigate } = useNavigate();
  const { items, add, update } = useRequirements(projectId);
  const openItems = items.filter((item) => item.status === 'open');

  const viewAll = () => {
    getProjectViewStore(projectId)?.setProjectView('requirements');
    navigate(projectViewDef({ projectId }));
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Popover.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative size-7 p-0 [-webkit-app-region:no-drag]"
                  aria-label="Requirements"
                />
              }
            />
          }
        >
          <ListPlus className="h-4 w-4" />
          {openItems.length > 0 ? (
            <Badge className="absolute -top-1 -right-1 h-3.5 min-w-3.5 justify-center px-0.5 text-[9px] tabular-nums">
              {openItems.length > 99 ? '99+' : openItems.length}
            </Badge>
          ) : null}
        </Tooltip.Trigger>
        <Tooltip.Content>Requirements</Tooltip.Content>
      </Tooltip.Root>
      <Popover.Content align="end" className="flex w-80 flex-col gap-3 p-3">
        <QuickRequirementInput autoFocus onAdd={add} />
        {openItems.length === 0 ? (
          <p className="text-xs text-foreground-muted">No open requirements</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {openItems.slice(0, RECENT_OPEN).map((item) => (
              <li key={item.id}>
                <label className="flex min-w-0 items-center gap-2 text-sm">
                  <Checkbox
                    checked={false}
                    onCheckedChange={(checked) => {
                      if (checked === true) void update({ id: item.id, status: 'done' });
                    }}
                  />
                  <span className="truncate" title={item.title}>
                    {item.title}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="ghost" className="self-end" onClick={viewAll}>
          View all ({items.length})
        </Button>
      </Popover.Content>
    </Popover.Root>
  );
}
