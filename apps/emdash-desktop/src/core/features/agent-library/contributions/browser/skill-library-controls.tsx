import { Button, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import { DEFAULT_AGENT_LIBRARY_SETTINGS } from '../../api';
import { getAgentLibraryClient } from '../../api/browser/client';
import { ScopePicker } from './scope-picker';

const AGENT_SKILLS_KEY = ['agentLibrary', 'agentSkills'];
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi',
  cursor: 'Cursor',
  shared: '~/.agents',
};

/** Where a library skill applies (all projects or some), edited in place on its card. */
export function SkillScope({ name }: { name: string }) {
  const { value, updateAsync } = useAppSettingsKey('agentLibrary');
  const settings = value ?? DEFAULT_AGENT_LIBRARY_SETTINGS;
  return (
    <ScopePicker
      projects={settings.skillProjects[name]}
      onChange={(projects) => {
        const skillProjects = { ...settings.skillProjects };
        if (projects.length === 0) delete skillProjects[name];
        else skillProjects[name] = projects;
        void updateAsync({ ...settings, skillProjects });
      }}
    />
  );
}

/**
 * How the library reaches agents, and the skills still sitting in the agents' own
 * folders (e.g. from cc-switch): import them, then take them over so Emdash is the
 * only source.
 */
export function AgentSkillsBanner() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data: found = [] } = useQuery({
    queryKey: AGENT_SKILLS_KEY,
    queryFn: async () => (await getAgentLibraryClient()).scanAgentSkills(),
  });
  const pending = found.filter((skill) => !skill.inLibrary);
  const importedOnly = found.filter((skill) => skill.inLibrary);
  const agents = [...new Set(found.flatMap((skill) => skill.agents))];

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: AGENT_SKILLS_KEY });
    }
  };

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <p className="text-xs text-foreground-muted">
        Every agent started in Emdash — new or resumed — gets these skills: Emdash links them into
        each workspace’s <code>.claude/skills</code> (Claude Code, OpenCode, Oh My Pi, Cursor) and{' '}
        <code>.agents/skills</code> (Codex, Pi), kept out of git. Limit a skill to some projects
        from its card.
      </p>
      {found.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">
            {pending.length > 0
              ? `${pending.length} skill${pending.length === 1 ? '' : 's'} in your agents’ own folders are not in the library yet`
              : `${importedOnly.length} library skill${importedOnly.length === 1 ? ' is' : 's are'} still also in your agents’ own folders`}{' '}
            ({agents.map((agent) => AGENT_LABELS[agent] ?? agent).join(', ')}).
          </span>
          {pending.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await (await getAgentLibraryClient()).importAgentSkills();
                  toast.success(
                    `Imported ${result.imported.length} skill${result.imported.length === 1 ? '' : 's'}${result.alreadyInLibrary.length ? `; ${result.alreadyInLibrary.length} were already in the library` : ''}`
                  );
                })
              }
            >
              Import into the library
            </Button>
          ) : null}
          {importedOnly.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const confirmed = await openModal('confirmActionModal', {
                    title: 'Take over your agents’ skills?',
                    description: `${importedOnly.length} skill folder${importedOnly.length === 1 ? '' : 's'} (${importedOnly.map((s) => s.name).join(', ')}) will move out of ${agents.map((agent) => AGENT_LABELS[agent] ?? agent).join(', ')} into a backup under ~/.agentskills/.emdash/takeover-backup. Agents started in Emdash keep them from the library; Claude, Codex and the others run outside Emdash (including the Claude app) will no longer see them.`,
                    confirmLabel: 'Take over',
                  });
                  if (!confirmed.success) return;
                  const result = await (await getAgentLibraryClient()).takeOverAgentSkills();
                  toast.success(
                    result.backupDir
                      ? `Moved ${result.moved} to ${result.backupDir}`
                      : 'Nothing to take over'
                  );
                })
              }
            >
              Take over…
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
