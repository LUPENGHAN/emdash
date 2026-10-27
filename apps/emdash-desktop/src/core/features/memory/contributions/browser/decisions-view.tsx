import { MemoryReader } from '../../browser/memory-reader';

/** The project's Decisions tab. The repository root and every worktree share this list. */
export function DecisionsView({ projectId }: { projectId: string }) {
  return (
    <MemoryReader
      scope={{ kind: 'project', projectId }}
      description="Decisions for this project. The repository root and every worktree share this list."
    />
  );
}
