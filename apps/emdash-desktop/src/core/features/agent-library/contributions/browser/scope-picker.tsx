import { DropdownMenu } from '@emdash/ui/react/primitives';
import { ChevronDown, FolderGit2, Globe } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  getProjectManagerStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { cn } from '@core/primitives/styling/browser/cn';

export type LibraryProject = { id: string; name: string };

export function libraryProjects(): LibraryProject[] {
  return Array.from(getProjectManagerStore().projects, ([id, store]) => ({
    id,
    name: projectDisplayName(store) ?? id,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Short label for a scope: every project, or the ones it is limited to. */
export function scopeLabel(projects: readonly string[] | undefined): string {
  if (!projects || projects.length === 0) return 'All projects';
  const names = libraryProjects();
  const named = projects.map((id) => names.find((project) => project.id === id)?.name ?? id);
  return named.length <= 2 ? named.join(', ') : `${named.length} projects`;
}

/**
 * Picks where a library skill or MCP server applies: every project, or some of them.
 * `projects` empty or absent means every project.
 */
export const ScopePicker = observer(function ScopePicker({
  projects,
  onChange,
  className,
}: {
  projects: readonly string[] | undefined;
  onChange: (projects: string[]) => void;
  className?: string;
}) {
  const all = libraryProjects();
  const selected = new Set(projects ?? []);
  const global = selected.size === 0;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'flex max-w-full items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-foreground-muted hover:text-foreground',
              className
            )}
          >
            {global ? (
              <Globe className="size-3 shrink-0" />
            ) : (
              <FolderGit2 className="size-3 shrink-0" />
            )}
            <span className="truncate">{scopeLabel(projects)}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </button>
        }
      />
      <DropdownMenu.Content className="min-w-56" onClick={(event) => event.stopPropagation()}>
        <DropdownMenu.Group>
          <DropdownMenu.Label>Available in</DropdownMenu.Label>
          <DropdownMenu.CheckboxItem checked={global} onCheckedChange={() => onChange([])}>
            All projects
          </DropdownMenu.CheckboxItem>
          {all.length > 0 ? <DropdownMenu.Separator /> : null}
          {all.map((project) => (
            <DropdownMenu.CheckboxItem
              key={project.id}
              checked={selected.has(project.id)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(project.id);
                else next.delete(project.id);
                onChange([...next]);
              }}
            >
              {project.name}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
});
