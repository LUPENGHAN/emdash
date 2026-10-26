import { ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { cn } from '@core/primitives/styling/browser/cn';
import { SidebarMenuRow } from './sidebar-primitives';

export const SidebarArchivedHeader = observer(function SidebarArchivedHeader({
  count,
}: {
  count: number;
}) {
  const expanded = getSidebarStore().archivedExpanded;
  return (
    <SidebarMenuRow
      className="h-8 px-1"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => getSidebarStore().toggleArchivedExpanded()}
    >
      <span className="flex min-w-0 items-center gap-1 text-foreground/70">
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
        <span className="truncate">{`Archived (${count})`}</span>
      </span>
    </SidebarMenuRow>
  );
});
