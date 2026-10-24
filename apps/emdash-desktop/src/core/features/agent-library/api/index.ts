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

export const skillSourceSchema = z.object({
  name: z.string(),
  repo: z.string(),
  path: z.string(),
  ref: z.string(),
  installedTree: z.string().nullable(),
  remoteTree: z.string().nullable(),
  installedHash: z.string().nullable(),
  dirty: z.boolean(),
  updateAvailable: z.boolean(),
});
export type SkillSourceView = z.infer<typeof skillSourceSchema>;

export const mcpServerStatusSchema = z.object({
  name: z.string(),
  kind: z.enum(['npm', 'pypi', 'http', 'docker', 'local']),
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  deprecated: z.string().nullable(),
  /** Unpinned packages, or anything else that is not a version bump or a deprecation. */
  note: z.string().nullable(),
  updateAvailable: z.boolean(),
});
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpHealthSchema = z.object({
  ok: z.boolean(),
  tools: z.number().nullable(),
  error: z.string().nullable(),
});
export type McpHealth = z.infer<typeof mcpHealthSchema>;

/** One skill found inside a GitHub link (see `scanGitHubSkills`). */
export const scannedGitHubSkillSchema = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string(),
  valid: z.boolean(),
  existsInLibrary: z.boolean(),
  skipped: z.array(z.string()),
});

/** One scan of a GitHub link: what was found, and what to install from it. */
export const githubSkillScanSchema = z.object({
  repo: z.string(),
  ref: z.string(),
  commit: z.string(),
  truncated: z.boolean(),
  skills: z.array(scannedGitHubSkillSchema),
});
export type GitHubSkillScan = z.infer<typeof githubSkillScanSchema>;

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
  listSkillSources: procedure({ input: z.void(), output: z.array(skillSourceSchema) }),
  checkSkillUpdates: procedure({ input: z.void(), output: z.array(skillSourceSchema) }),
  setSkillSource: procedure({
    input: z.object({ name: z.string().min(1), url: z.string().min(1) }),
    output: skillSourceSchema,
  }),
  updateSkill: procedure({
    input: z.object({ name: z.string().min(1), force: z.boolean().default(false) }),
    output: z.object({
      updated: z.boolean(),
      dirty: z.boolean(),
      files: z.array(z.string()),
      source: skillSourceSchema,
    }),
  }),
  /** Lists the skills inside a GitHub link; the account's token is used, never shown. */
  scanGitHubSkills: procedure({
    input: z.object({ url: z.string().min(1) }),
    output: githubSkillScanSchema,
  }),
  installGitHubSkills: procedure({
    input: z.object({
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      ref: z.string().min(1),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      picks: z
        .array(
          z.object({
            path: z.string(),
            name: z.string().min(1),
            overwrite: z.boolean(),
          })
        )
        .min(1)
        .max(50),
    }),
    output: z.object({
      installed: z.array(z.string()),
      skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
    }),
  }),
  /** Checks the library's stored definition of the named server. */
  checkMcpServer: procedure({
    input: z.object({ name: z.string().min(1) }),
    output: mcpServerStatusSchema,
  }),
  /** Starts (or calls) the library's stored definition of the named server. */
  checkMcpHealth: procedure({
    input: z.object({ name: z.string().min(1) }),
    output: mcpHealthSchema,
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
