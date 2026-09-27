import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Emdash's own library of skills and MCP servers — the one place agents get them from.
 * Skills live in `~/.agentskills` and reach every agent started in Emdash through the
 * workspace's `.agents/skills` (which Claude Code, Codex, OpenCode, Pi, Oh My Pi and
 * Cursor all read); MCP servers are added to each launch. Either can be global or
 * limited to some projects.
 */

export const libraryMcpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  /** Limited to these projects; absent or empty means every project. */
  projects: z.array(z.string()).optional(),
});
export type LibraryMcpServer = z.infer<typeof libraryMcpServerSchema>;

export const agentLibrarySettingsSchema = z.object({
  /** Skill name → the projects it is limited to; skills not listed are global. */
  skillProjects: z.record(z.string(), z.array(z.string())).default({}),
  mcpServers: z.array(libraryMcpServerSchema).default([]),
});
export type AgentLibrarySettings = z.infer<typeof agentLibrarySettingsSchema>;

export const DEFAULT_AGENT_LIBRARY_SETTINGS: AgentLibrarySettings = {
  skillProjects: {},
  mcpServers: [],
};

/** An MCP server as a launch receives it. */
export type LaunchMcpServer = Pick<
  LibraryMcpServer,
  'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers'
>;

function inScope(projects: readonly string[] | undefined, projectId: string | null): boolean {
  if (!projects || projects.length === 0) return true;
  return projectId !== null && projects.includes(projectId);
}

/** The library skills a project's agents get. */
export function effectiveSkillNames(
  library: readonly string[],
  settings: AgentLibrarySettings,
  projectId: string | null
): string[] {
  return library.filter((name) => inScope(settings.skillProjects[name], projectId));
}

/** The library MCP servers a project's agents get. */
export function effectiveMcpServers(
  settings: AgentLibrarySettings,
  projectId: string | null
): LaunchMcpServer[] {
  return settings.mcpServers
    .filter((server) => server.enabled !== false && inScope(server.projects, projectId))
    .map(({ name, transport, command, args, env, url, headers }) => ({
      name,
      transport,
      command,
      args,
      env,
      url,
      headers,
    }));
}

/** A skill found in an agent's own folder (outside Emdash). */
export type AgentSkillFound = {
  name: string;
  description: string;
  /** Agents whose folders have it, e.g. ['claude', 'codex']. */
  agents: string[];
  /** Whether the library already has a skill with this name. */
  inLibrary: boolean;
};

export type AgentSkillImportResult = { imported: string[]; alreadyInLibrary: string[] };
export type AgentSkillTakeOverResult = { moved: number; backupDir: string | null };

export const agentLibraryDomain = 'agentLibrary' as const;

export const agentLibraryContract = defineContract({
  /** Skills in the agents' own folders (~/.claude/skills and the like). */
  scanAgentSkills: procedure({ input: z.void(), output: z.custom<AgentSkillFound[]>() }),
  /** Copies them into the library (following symlinks); existing names are kept. */
  importAgentSkills: procedure({
    input: z.void(),
    output: z.custom<AgentSkillImportResult>(),
  }),
  /**
   * Moves the agents' own copies of library skills into a backup folder, so only
   * Emdash hands them out.
   */
  takeOverAgentSkills: procedure({
    input: z.void(),
    output: z.custom<AgentSkillTakeOverResult>(),
  }),
  /** The skills and MCP servers a project's agents get (for display). */
  effectiveFor: procedure({
    input: z.object({ projectId: z.string().nullable() }),
    output: z.object({
      skills: z.array(z.object({ name: z.string(), description: z.string() })),
      mcpServers: z.array(z.string()),
    }),
  }),
});
