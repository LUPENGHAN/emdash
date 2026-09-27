import path from 'node:path';
import { isNotNull } from 'drizzle-orm';
import {
  liveWorkspaces,
  workspaceRegistryTable as workspaces,
} from '@core/features/workspaces/api/node/registry';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects } from '@core/services/app-db/node/schema';
import {
  effectiveMcpServers,
  effectiveSkillNames,
  type AgentLibrarySettings,
  type AgentSkillFound,
  type AgentSkillImportResult,
  type AgentSkillTakeOverResult,
  type LaunchMcpServer,
} from '../api';
import {
  importSkills,
  listLibrarySkills,
  scanAgentSkills,
  SKILL_LIBRARY_DIRNAME,
  syncWorkspaceSkills,
  takeOverSkills,
} from './skill-library';

export type LocalWorkspace = { projectId: string; path: string };

export type AgentLibraryServiceDeps = {
  home: string;
  getSettings: () => Promise<AgentLibrarySettings>;
  onSettingsChanged: (listener: () => void) => () => void;
  /** Every live workspace on this computer, with its project. */
  listLocalWorkspaces: () => Promise<LocalWorkspace[]>;
  /** Tells the skill catalog UI that the library folder changed. */
  refreshSkillCatalog: () => Promise<void>;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

/**
 * Hands the library to agents: workspaces' `.agents/skills` mirror the skills in scope
 * (before every launch, and whenever the library or scopes change), and launches get the
 * MCP servers in scope. Also imports from, and takes over, the agents' own skill folders.
 */
export function createAgentLibraryService(deps: AgentLibraryServiceDeps) {
  const libraryDir = path.join(deps.home, SKILL_LIBRARY_DIRNAME);
  const backupRoot = path.join(libraryDir, '.emdash', 'takeover-backup');
  const inFlight = new Map<string, Promise<void>>();

  const libraryNames = async () => (await listLibrarySkills(libraryDir)).map((s) => s.name);

  const sync = (workspace: LocalWorkspace): Promise<void> => {
    // One sync per folder at a time; a later request waits and re-reads the settings.
    const previous = inFlight.get(workspace.path) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const names = effectiveSkillNames(
          await libraryNames(),
          await deps.getSettings(),
          workspace.projectId
        );
        await syncWorkspaceSkills({ workspacePath: workspace.path, libraryDir, names });
      })
      .catch((error: unknown) => {
        deps.warn?.('agent library: could not sync workspace skills', {
          workspace: workspace.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    inFlight.set(workspace.path, next);
    return next;
  };

  const resyncAll = async (): Promise<void> => {
    const all = await deps.listLocalWorkspaces().catch(() => [] as LocalWorkspace[]);
    await Promise.all(all.map((workspace) => sync(workspace)));
  };

  const scan = async () => scanAgentSkills(deps.home, new Set(await libraryNames()));

  const unsubscribe = deps.onSettingsChanged(() => void resyncAll());

  return {
    /** Before an agent starts (or resumes) in a local workspace. */
    prepareWorkspace: (workspace: LocalWorkspace) => sync(workspace),
    resyncAll,
    async launchMcpServers(projectId: string | null): Promise<LaunchMcpServer[]> {
      return effectiveMcpServers(await deps.getSettings(), projectId);
    },
    async effectiveFor(projectId: string | null) {
      const settings = await deps.getSettings();
      const library = await listLibrarySkills(libraryDir);
      const names = new Set(
        effectiveSkillNames(
          library.map((skill) => skill.name),
          settings,
          projectId
        )
      );
      return {
        skills: library.filter((skill) => names.has(skill.name)),
        mcpServers: effectiveMcpServers(settings, projectId).map((server) => server.name),
      };
    },
    async scanAgentSkills(): Promise<AgentSkillFound[]> {
      return (await scan()).map(({ sources: _sources, ...found }) => found);
    },
    async importAgentSkills(): Promise<AgentSkillImportResult> {
      const result = await importSkills(await scan(), libraryDir);
      await deps.refreshSkillCatalog().catch(() => {});
      await resyncAll();
      return result;
    },
    async takeOverAgentSkills(): Promise<AgentSkillTakeOverResult> {
      return takeOverSkills(await scan(), new Set(await libraryNames()), backupRoot, deps.home);
    },
    dispose: () => unsubscribe(),
  };
}

export type AgentLibraryService = ReturnType<typeof createAgentLibraryService>;

/** Live local workspaces (project checkouts and task worktrees) with their project. */
export async function listLocalWorkspaces(db: AppDb): Promise<LocalWorkspace[]> {
  const projectRows = await db
    .select({ id: projects.id, repositoryWorkspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(isNotNull(projects.repositoryWorkspaceId));
  const projectByRepository = new Map(
    projectRows.map((row) => [row.repositoryWorkspaceId!, row.id])
  );
  const rows = await db
    .select({
      id: workspaces.id,
      path: workspaces.path,
      parentId: workspaces.parentId,
      location: workspaces.location,
    })
    .from(workspaces)
    .where(liveWorkspaces());
  const out: LocalWorkspace[] = [];
  for (const row of rows) {
    if (!row.path || row.location === 'remote') continue;
    const projectId =
      projectByRepository.get(row.id) ??
      (row.parentId ? projectByRepository.get(row.parentId) : undefined);
    if (projectId) out.push({ projectId, path: row.path });
  }
  return out;
}
