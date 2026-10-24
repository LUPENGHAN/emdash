import { CollectionToolbar } from '@emdash/ui/react/patterns';
import { Button } from '@emdash/ui/react/primitives';
import { FolderOpen, Github, Plus, RefreshCw } from 'lucide-react';
import React from 'react';
import { useSearchFocusHotkeys } from '@core/primitives/keybindings/browser';

type SkillsToolbarProps = {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateSkill: () => void;
  onImportFromGitHub: () => void;
  onImportLocal?: () => void;
};

export function SkillsToolbar({
  searchQuery,
  onSearchQueryChange,
  onRefresh,
  isRefreshing,
  onCreateSkill,
  onImportFromGitHub,
  onImportLocal,
}: SkillsToolbarProps) {
  const searchRef = useSearchFocusHotkeys();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        ref={searchRef}
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search skills…"
      />
      <CollectionToolbar.Spacer />
      <CollectionToolbar.Group>
        <Button
          variant="secondary"
          icon
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label="Refresh catalog"
        >
          <RefreshCw
            className={`text-muted-foreground h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
          />
        </Button>
        {onImportLocal ? (
          <Button variant="secondary" onClick={onImportLocal}>
            <FolderOpen className="size-4" />
            Import
          </Button>
        ) : null}
        <Button variant="secondary" onClick={onImportFromGitHub}>
          <Github className="size-4" />
          Import from GitHub
        </Button>
        <Button variant="primary" onClick={onCreateSkill}>
          <Plus className="size-4" />
          New Skill
        </Button>
      </CollectionToolbar.Group>
    </CollectionToolbar.Root>
  );
}
