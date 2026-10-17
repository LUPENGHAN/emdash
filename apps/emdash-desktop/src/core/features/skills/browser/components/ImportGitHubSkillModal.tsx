import { Button, Checkbox, Dialog, Input, Label, toast } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { GitHubSkillScan } from '@core/features/agent-library/api';
import { getAgentLibraryClient } from '@core/features/agent-library/api/browser/client';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';

/** One scan of a GitHub link: what was found, and what to install from it. */
type Scan = GitHubSkillScan;

export function ImportGitHubSkillModal() {
  const { complete, dismiss } = useModalController('importGitHubSkillModal');
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [skippedResults, setSkippedResults] = useState<{ name: string; reason: string }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  useCloseGuard(isSearching || isInstalling);

  const handleFindSkills = async () => {
    setScanError(null);
    setIsSearching(true);
    try {
      const client = await getAgentLibraryClient();
      const result = await client.scanGitHubSkills({ url: url.trim() });
      setScan(result);
      // One skill: obviously the one they want. Many: their choice.
      setPicked(result.skills.length === 1 ? [result.skills[0]!.path] : []);
      setSkippedResults([]);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Failed to search GitHub');
    } finally {
      setIsSearching(false);
    }
  };

  const handleInstall = async () => {
    if (!scan || picked.length === 0) return;
    setIsInstalling(true);
    try {
      const client = await getAgentLibraryClient();
      const byPath = new Map(scan.skills.map((skill) => [skill.path, skill]));
      const result = await client.installGitHubSkills({
        repo: scan.repo,
        ref: scan.ref,
        commit: scan.commit,
        picks: picked.map((path) => {
          const skill = byPath.get(path)!;
          return { path, name: skill.name, overwrite: skill.existsInLibrary };
        }),
      });
      if (result.installed.length > 0) {
        toast.success(`Installed ${result.installed.length} skills`);
        void queryClient.invalidateQueries({ queryKey: ['skills', 'catalog'] });
        void queryClient.invalidateQueries({ queryKey: ['agentLibrary', 'skillSources'] });
      }
      if (result.skipped.length > 0) {
        setSkippedResults(result.skipped);
        setPicked(picked.filter((path) => !result.installed.includes(byPath.get(path)!.name)));
        return;
      }
      complete();
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Failed to install skills');
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Import Skills from GitHub</Dialog.Title>
      </Dialog.Header>

      <Dialog.Body>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="github-url">GitHub link</Label>
            <div className="flex gap-2">
              <Input
                id="github-url"
                placeholder="https://github.com/owner/repo"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setScanError(null);
                }}
                className="text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && url.trim() && !isSearching) {
                    void handleFindSkills();
                  }
                }}
              />
              <ConfirmButton
                variant="secondary"
                type="button"
                onClick={() => void handleFindSkills()}
                disabled={!url.trim() || isSearching}
              >
                {isSearching ? 'Searching…' : 'Find skills'}
              </ConfirmButton>
            </div>
          </div>

          {scanError && <p className="text-destructive text-xs">{scanError}</p>}

          {scan && (
            <div className="space-y-2">
              {scan.truncated && <p className="text-xs">Showing the first 50 skills.</p>}
              {skippedResults.map((entry) => (
                <p key={entry.name} className="text-muted-foreground text-xs">
                  {`Skipped ${entry.name}: ${entry.reason}`}
                </p>
              ))}
              <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-1">
                {scan.skills.map((skill) => {
                  const checked = picked.includes(skill.path);
                  return (
                    <li
                      key={skill.path}
                      className="flex items-start gap-2 rounded px-2 py-1 hover:bg-background-1"
                    >
                      <label className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={!skill.valid || isInstalling}
                          onCheckedChange={(value) =>
                            setPicked((current) =>
                              value === true
                                ? [...current, skill.path]
                                : current.filter((path) => path !== skill.path)
                            )
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{skill.name}</span>
                          <span className="text-muted-foreground line-clamp-2 block text-xs">
                            {skill.description}
                          </span>
                          <span className="text-muted-foreground block text-[10px]">
                            {skill.path || 'repository root'}
                          </span>
                        </span>
                      </label>
                      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10px]">
                        {!skill.valid && <span className="text-warning">Invalid name</span>}
                        {skill.existsInLibrary && (
                          <span className="text-muted-foreground">
                            Already in the library — installing replaces it
                          </span>
                        )}
                        {skill.skipped.length > 0 && (
                          <span className="text-muted-foreground">
                            {`${skill.skipped.length} links or submodules will not be copied`}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </Dialog.Body>

      <Dialog.Footer className="gap-2 sm:gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={dismiss}
          disabled={isSearching || isInstalling}
        >
          Cancel
        </Button>
        <ConfirmButton
          variant="primary"
          type="button"
          onClick={() => void handleInstall()}
          size="sm"
          disabled={!scan || picked.length === 0 || isInstalling}
        >
          {isInstalling ? 'Installing…' : `Install (${picked.length})`}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
}

export const importGitHubSkillModal = defineModal<void>()({
  id: 'importGitHubSkillModal',
  component: ImportGitHubSkillModal,
});
