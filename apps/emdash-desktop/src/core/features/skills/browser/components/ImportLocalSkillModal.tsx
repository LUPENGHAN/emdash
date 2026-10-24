import { Button, Dialog, toast } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SkillSourceView } from '@core/features/agent-library/api';
import { getAgentLibraryClient } from '@core/features/agent-library/api/browser/client';
import { useModalController, useOpenModal } from '@core/manifests/browser/modal-api';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';

function replaceDescription(names: string[], sources: SkillSourceView[]): string {
  const byName = new Map(sources.map((source) => [source.name, source]));
  return names
    .flatMap((name) => {
      const source = byName.get(name);
      const lines = [name];
      if (source?.dirty) lines.push('This skill differs from the last copy Emdash wrote.');
      if (source) {
        const located = `${source.repo}${source.path ? `/${source.path}` : ''}`;
        lines.push(
          `GitHub source stays: ${located}. Update will ask again before it replaces these files.`
        );
      }
      return lines;
    })
    .join('\n');
}

export function ImportLocalSkillModal() {
  const { complete } = useModalController('importLocalSkillModal');
  const openConfirm = useOpenModal('confirmActionModal');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useCloseGuard(busy);

  const importPath = async (sourcePath: string) => {
    setError(null);
    setBusy(true);
    try {
      const client = await getAgentLibraryClient();
      const plan = await client.importLocalSkills({
        sourcePath,
        cwd: null,
        overwrite: false,
        apply: false,
      });
      if (plan.pendingReplace.length > 0) {
        const sources = await client.listSkillSources();
        const outcome = await openConfirm({
          title: 'Replace skills already in the library?',
          description: replaceDescription(plan.pendingReplace, sources),
          confirmLabel: 'Replace',
          variant: 'default',
        });
        if (!outcome.success) return;
      }
      const result = await client.importLocalSkills({
        sourcePath,
        cwd: null,
        overwrite: plan.pendingReplace.length > 0,
        apply: true,
      });
      const summary = [
        result.imported.length > 0 ? `Imported ${result.imported.join(', ')}` : null,
        result.replaced.length > 0 ? `Replaced ${result.replaced.join(', ')}` : null,
      ].filter((line) => line !== null);
      if (summary.length === 0) {
        setError(
          result.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join('\n') ||
            'No skills imported.'
        );
        return;
      }
      toast.success(summary.join('. '), {
        description:
          result.skipped.length > 0
            ? result.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join('\n')
            : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ['agentLibrary', 'skillSources'] });
      complete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not import the skill');
    } finally {
      setBusy(false);
    }
  };

  const choose = async (kind: 'folder' | 'zip') => {
    setError(null);
    const host = await getHostClient();
    const picked =
      kind === 'folder'
        ? await host.openSelectDirectoryDialog({
            title: 'Import a skill folder',
            message: 'Choose a folder that contains SKILL.md',
          })
        : await host.openSelectZipDialog({
            title: 'Import a skill archive',
            message: 'Choose a .zip file',
          });
    if (!picked) return;
    await importPath(picked);
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Import a skill</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Choose a folder or a .zip file. Replacing a skill already in the library asks first.
          </p>
          {error ? <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p> : null}
        </div>
      </Dialog.Body>
      <Dialog.Footer className="gap-2 sm:gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void choose('folder')}
        >
          Folder
        </Button>
        <ConfirmButton
          type="button"
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => void choose('zip')}
        >
          Zip
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
}

export const importLocalSkillModal = defineModal<void>()({
  id: 'importLocalSkillModal',
  component: ImportLocalSkillModal,
});
