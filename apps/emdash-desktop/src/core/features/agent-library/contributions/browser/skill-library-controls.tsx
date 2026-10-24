import { Button, Input, toast } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import { DEFAULT_AGENT_LIBRARY_SETTINGS, type SkillSourceView } from '../../api';
import { getAgentLibraryClient } from '../../api/browser/client';
import { ScopePicker } from './scope-picker';
import {
  bumpSkillSourceGeneration,
  currentSkillSourceGeneration,
  skillSourceCheckMayWrite,
  skillUpdateAffordance,
  skillUpdateButtonLabel,
  skillUpdateForRow,
} from './skill-update-affordance';

const SKILL_SOURCES_KEY = ['agentLibrary', 'skillSources'];
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Source, update, and where a library skill applies. */
export function SkillSource({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: sources = [] } = useQuery({
    queryKey: SKILL_SOURCES_KEY,
    queryFn: async () => (await getAgentLibraryClient()).listSkillSources(),
  });
  const source = sources.find((item) => item.name === name);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: SKILL_SOURCES_KEY });
  };

  const saveSource = async () => {
    setBusy(true);
    try {
      await (await getAgentLibraryClient()).setSkillSource({ name, url });
      setEditing(false);
      setUrl('');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    const started = currentSkillSourceGeneration();
    try {
      const sources = await (await getAgentLibraryClient()).checkSkillUpdates();
      if (!skillSourceCheckMayWrite(started, { aborted: false })) return;
      queryClient.setQueryData(SKILL_SOURCES_KEY, sources);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    setBusy(true);
    try {
      const client = await getAgentLibraryClient();
      let result = await client.updateSkill({ name, force: false });
      if (result.dirty) {
        const confirmed = await openModal('confirmActionModal', {
          title: `Replace local edits in ${name}?`,
          description: `This skill differs from the last copy Emdash wrote. Updating replaces the folder${result.files.length ? `: ${result.files.slice(0, 8).join(', ')}` : ''}.`,
          confirmLabel: 'Replace',
        });
        if (!confirmed.success) return;
        result = await client.updateSkill({ name, force: true });
      }
      bumpSkillSourceGeneration();
      const source = skillUpdateForRow(name, result.source);
      if (!source) {
        toast.error(`Update for ${name} returned ${result.source.name}`);
        return;
      }
      queryClient.setQueryData(SKILL_SOURCES_KEY, (current: SkillSourceView[] | undefined) =>
        (current ?? []).map((item) => (item.name === source.name ? source : item))
      );
      toast.success(result.updated ? `Updated ${name}` : `${name} is already current`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
        <Input
          value={url}
          placeholder="https://github.com/owner/repo/tree/main/path"
          className="h-6 w-56 text-xs"
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !url.trim()}
          onClick={() => void saveSource()}
        >
          Save
        </Button>
      </span>
    );
  }

  const affordance = skillUpdateAffordance(source);
  const buttonLabel = skillUpdateButtonLabel(affordance);
  return (
    <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="max-w-48 truncate text-xs text-foreground-muted hover:text-foreground"
        onClick={() => setEditing(true)}
      >
        {source ? `${source.repo}${source.path ? `/${source.path}` : ''}` : 'No source'}
      </button>
      {source?.updateAvailable ? <span className="text-xs">Update available</span> : null}
      {affordance === 'up-to-date' ? <span className="text-xs">Up to date</span> : null}
      {source?.dirty ? <span className="text-xs text-foreground-muted">Local edits</span> : null}
      {buttonLabel ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void (buttonLabel === 'Check' ? check() : update())}
        >
          {buttonLabel}
        </Button>
      ) : null}
    </span>
  );
}

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
  useQuery({
    queryKey: ['agentLibrary', 'skillSourceCheck'],
    staleTime: DAY_MS,
    queryFn: async ({ signal }) => {
      const started = currentSkillSourceGeneration();
      const sources = await (await getAgentLibraryClient()).checkSkillUpdates();
      if (skillSourceCheckMayWrite(started, signal)) {
        queryClient.setQueryData(SKILL_SOURCES_KEY, sources);
      }
      return sources;
    },
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
                    description: `The agents’ own copies of ${importedOnly.length} skill${importedOnly.length === 1 ? '' : 's'} (${importedOnly.map((s) => s.name).join(', ')}) will move out of ${agents.map((agent) => AGENT_LABELS[agent] ?? agent).join(', ')} into a backup under ~/.agentskills/.emdash/takeover-backup. Agents started in Emdash keep them from the library; Claude, Codex and the others run outside Emdash (including the Claude app) will no longer see them.`,
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
