import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatMemoryList, formatMemoryRecord } from '@core/features/memory/api/format';
import {
  MEMORY_DETAIL_MAX,
  MEMORY_TITLE_MAX,
  type MemoryOperations,
  type MemoryScope,
  type MemorySource,
} from '@core/features/memory/api/types';
import type { UsageLimits } from '@core/features/model-providers/api';
import {
  directChildren,
  indexRequirements,
  topLevelParent,
} from '@core/features/requirements/api/requirement-tree';
import {
  REQUIREMENT_DETAIL_MAX,
  REQUIREMENT_TITLE_MAX,
  type Requirement,
  type RequirementsOperations,
} from '@core/features/requirements/api/types';
import {
  NAVIGATION_COMMAND_IDS,
  type AgentCaller,
  type AgentControlAction,
  type AgentControlResult,
} from '../api';

/** Agents Emdash can start; the ids tools accept for `agent`. */
export const AGENT_IDS = ['claude', 'codex', 'opencode', 'pi', 'oh-my-pi', 'cursor'] as const;
const agentSchema = z.enum(AGENT_IDS);

export type AgentControlToolContext = {
  caller: AgentCaller;
  dispatch: (action: AgentControlAction) => Promise<AgentControlResult>;
  usageLimits: () => Promise<UsageLimits>;
  requirements: Pick<RequirementsOperations, 'list' | 'add' | 'update' | 'remove'>;
  memory: Pick<MemoryOperations, 'list' | 'add' | 'get' | 'update' | 'remove'>;
};

/** How much of a requirement's detail list_requirements shows. */
const LISTED_DETAIL_MAX = 300;

function formatRequirement(item: Requirement, depth: number): string {
  const pad = '  '.repeat(depth);
  const parent = item.parentId ? ` parent:${item.parentId}` : '';
  const line = `${pad}${item.id} [${item.status}] ${item.title}${parent}`;
  if (!item.detail) return line;
  const detail =
    item.detail.length > LISTED_DETAIL_MAX
      ? `${item.detail.slice(0, LISTED_DETAIL_MAX)}…`
      : item.detail;
  return `${line}\n${detail.replace(/^/gm, `${pad}  `)}`;
}

/** Sub-requirements sit under a parent that is also in this list, oldest first. */
function formatRequirements(items: Requirement[]): string {
  const byId = indexRequirements(items);
  const nested = new Set(
    items.filter((item) => topLevelParent(item, byId) !== null).map((item) => item.id)
  );
  const lines: string[] = [];
  for (const item of items) {
    if (nested.has(item.id)) continue;
    lines.push(formatRequirement(item, 0));
    if (item.parentId) continue;
    for (const child of directChildren(item.id, items)) {
      lines.push(formatRequirement(child, 1));
    }
  }
  return lines.join('\n');
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

function toToolResult(result: AgentControlResult): ToolResult {
  const content: ToolContent[] = [{ type: 'text', text: result.text }];
  if (result.image) content.push({ type: 'image', ...result.image });
  return { content };
}

async function run(work: () => Promise<AgentControlResult>): Promise<ToolResult> {
  try {
    return toToolResult(await work());
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function formatUsageLimits(limits: UsageLimits): string {
  const lines = limits.agents.map((agent) => {
    if (agent.unavailable) return `${agent.agent}: unknown (${agent.unavailable})`;
    const windows = agent.windows.map(
      (window) =>
        `${window.label} ${window.usedPercent}% used${window.resets ? `, resets ${window.resets}` : ''}`
    );
    const plan = agent.plan ? ` [${agent.plan}]` : '';
    return `${agent.agent}${plan}: ${windows.length ? windows.join('; ') : 'no windows reported'}`;
  });
  return lines.join('\n') || 'No subscription usage reported.';
}

/**
 * The tools every agent gets from Emdash's built-in MCP server ("emdash"). Tools that
 * start work, message another agent or run commands ask the user in Emdash first.
 */
export function registerAgentControlTools(server: McpServer, ctx: AgentControlToolContext): void {
  const { caller } = ctx;
  const dispatch = (action: AgentControlAction) => run(() => ctx.dispatch(action));

  // ── Where am I, and how much quota is left ─────────────────────────────────────
  server.registerTool(
    'whoami',
    {
      description:
        'Where this conversation runs in Emdash: project, task, working directory, and which agent you are. Other agents available: ' +
        AGENT_IDS.join(', '),
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => ({
        text: [
          `You are ${caller.providerId} in the Emdash conversation "${caller.title}" (${caller.conversationId}).`,
          `Task: ${caller.taskId} · Project: ${caller.projectId}`,
          caller.cwd ? `Working directory: ${caller.cwd}` : null,
          `Agents you can hand off to or start: ${AGENT_IDS.join(', ')}.`,
        ]
          .filter(Boolean)
          .join('\n'),
      }))
  );

  server.registerTool(
    'usage_limits',
    {
      description:
        "The user's subscription usage: Claude Code and Codex 5-hour and weekly windows, and the Cursor plan. Check before long work; hand off before a window runs out.",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => ({ text: formatUsageLimits(await ctx.usageLimits()) }))
  );

  // ── Working with other agents ──────────────────────────────────────────────────
  server.registerTool(
    'list_conversations',
    {
      description:
        'Conversations in this task (or the whole project) with their agent, model and status (working, waiting for input, idle).',
      inputSchema: { scope: z.enum(['task', 'project']).default('task') },
      annotations: { readOnlyHint: true },
    },
    ({ scope }) => dispatch({ kind: 'list_conversations', scope })
  );

  server.registerTool(
    'create_conversation',
    {
      description:
        'Start another agent in this task with a first message, e.g. ask codex to review your change. The user confirms in Emdash.',
      inputSchema: {
        agent: agentSchema,
        prompt: z.string().min(1).describe('The first message the new agent receives'),
        model: z.string().optional().describe("Model id; omit for the agent's default"),
        ui: z.enum(['terminal', 'chat']).optional(),
      },
    },
    ({ agent, prompt, model, ui }) =>
      dispatch({ kind: 'create_conversation', providerId: agent, prompt, model, ui })
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to another conversation in this task (get ids from list_conversations). The user confirms in Emdash.',
      inputSchema: { conversation_id: z.string(), text: z.string().min(1) },
    },
    ({ conversation_id, text }) =>
      dispatch({ kind: 'send_message', conversationId: conversation_id, text })
  );

  server.registerTool(
    'handoff',
    {
      description:
        "Hand this conversation's work to another agent: it starts with the original ask, your last reply, the git state and a transcript path. Use when your quota is nearly out or another agent suits the work better. The user confirms in Emdash.",
      inputSchema: {
        agent: agentSchema,
        model: z.string().optional(),
        note: z.string().optional().describe('Anything the next agent should know first'),
      },
    },
    ({ agent, model, note }) => dispatch({ kind: 'handoff', providerId: agent, model, note })
  );

  server.registerTool(
    'suggest_task',
    {
      description:
        'Suggest separate work you noticed but should not do now (a bug elsewhere, missing tests, stale docs). The user sees a button to start it as a new task.',
      inputSchema: {
        title: z.string().min(1).max(80),
        prompt: z.string().min(1).describe('Self-contained instructions for whoever picks it up'),
      },
    },
    ({ title, prompt }) => dispatch({ kind: 'suggest_task', title, prompt })
  );

  server.registerTool(
    'create_task',
    {
      description:
        "Create a git worktree through Emdash, as a new task in this project: use this instead of `git worktree add` (or a worktree tool of your own), so the worktree lands where Emdash keeps them and the user can see and review its code in Emdash. Returns the worktree's path and branch; work there yourself, or pass `prompt` to start an agent in it. The user confirms in Emdash.",
      inputSchema: {
        name: z.string().min(1).max(80).describe('Task name, e.g. "fix-login-timeout"'),
        base_branch: z
          .string()
          .optional()
          .describe("Branch to start from; omit for this task's current branch"),
        prompt: z
          .string()
          .optional()
          .describe('Start an agent in the new task with this first message'),
        agent: agentSchema.optional().describe('Agent for `prompt`; omit for yourself'),
        ui: z.enum(['terminal', 'chat']).optional(),
      },
    },
    ({ name, base_branch, prompt, agent, ui }) =>
      dispatch({
        kind: 'create_task',
        name,
        ...(base_branch && { baseBranch: base_branch }),
        ...(prompt && { prompt, providerId: agent ?? caller.providerId }),
        ...(ui && { ui }),
      })
  );

  // ── Tasks in this project ──────────────────────────────────────────────────────
  server.registerTool(
    'list_tasks',
    {
      description:
        'Tasks in this project: id, name, branch, status, whether an agent is running in it, and when it was created. Yours is marked. Use the id with archive_task or delete_task.',
      inputSchema: { include_archived: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    ({ include_archived }) => dispatch({ kind: 'list_tasks', includeArchived: include_archived })
  );

  server.registerTool(
    'archive_task',
    {
      description:
        'Archive a task in this project (it can be restored in Emdash later). Not your own task, and not one with an agent still running. The user confirms in Emdash.',
      inputSchema: { task_id: z.string().min(1) },
    },
    ({ task_id }) => dispatch({ kind: 'archive_task', taskId: task_id })
  );

  server.registerTool(
    'delete_task',
    {
      description:
        'Delete a task in this project. The user decides in Emdash whether its worktree and branch go too, and sees any unpushed commits first. Cannot be undone. Not your own task, and not one with an agent still running. Prefer archive_task unless the user asked for deletion.',
      inputSchema: { task_id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ task_id }) => dispatch({ kind: 'delete_task', taskId: task_id })
  );

  server.registerTool(
    'import_skill',
    {
      description:
        "Import a skill folder or .zip into Emdash's skill library (~/.agentskills). " +
        'Creates missing skills. Replacing one that is already there asks the user in Emdash, unless force is true. ' +
        'path is a filesystem path, never a shell command. Files stay inside the library.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Absolute path, or a path relative to this task, of a skill folder or .zip'),
        force: z
          .boolean()
          .default(false)
          .describe('Replace an existing skill without the confirm dialog'),
      },
      annotations: { destructiveHint: true },
    },
    ({ path, force = false }) => dispatch({ kind: 'import_skill', path, force })
  );

  // ── The project's requirements list ────────────────────────────────────────────
  server.registerTool(
    'add_requirement',
    {
      description:
        "Add an item to this project's requirements list in Emdash: something the user wants done later, or follow-up work you noticed. The user sees it at once and can start it as a task. Pass parentId to add one sub-requirement under a top-level item.",
      inputSchema: {
        title: z.string().min(1).max(REQUIREMENT_TITLE_MAX),
        detail: z.string().max(REQUIREMENT_DETAIL_MAX).optional(),
        parentId: z
          .string()
          .min(1)
          .optional()
          .describe('Id of a top-level requirement. Omit it to add a top-level item.'),
      },
    },
    ({ title, detail, parentId }) =>
      run(async () => {
        const item = await ctx.requirements.add(
          caller.projectId,
          { title, detail, ...(parentId ? { parentId } : {}) },
          {
            kind: 'agent',
            providerId: caller.providerId,
            conversationId: caller.conversationId,
            taskId: caller.taskId,
          }
        );
        return { text: `Added requirement ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'list_requirements',
    {
      description:
        "This project's requirements list in Emdash, with ids for complete_requirement. Sub-requirements are indented under their parent and include that parent id.",
      inputSchema: { status: z.enum(['open', 'done', 'all']).default('open') },
      annotations: { readOnlyHint: true },
    },
    ({ status }) =>
      run(async () => {
        const items = (await ctx.requirements.list(caller.projectId)).filter(
          (item) => status === 'all' || item.status === status
        );
        return {
          text: items.length ? formatRequirements(items) : 'No requirements.',
        };
      })
  );

  server.registerTool(
    'complete_requirement',
    {
      description:
        "Mark an item on this project's requirements list done, once the work for it is finished.",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(async () => {
        const item = await ctx.requirements.update(caller.projectId, id, { status: 'done' });
        return { text: `Marked requirement ${item.id} done: ${item.title}` };
      })
  );

  server.registerTool(
    'update_requirement',
    {
      description:
        'Change the title or detail of one requirement in this project. Pass at least one. An empty detail clears the text. It takes effect at once, without confirmation, and does not change status or which requirement it sits under.',
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(REQUIREMENT_TITLE_MAX).optional(),
        detail: z.string().max(REQUIREMENT_DETAIL_MAX).optional(),
      },
    },
    ({ id, title, detail }) =>
      run(async () => {
        if (title === undefined && detail === undefined) {
          throw new Error('Pass a title, a detail, or both');
        }
        const item = await ctx.requirements.update(caller.projectId, id, {
          ...(title !== undefined && { title }),
          ...(detail !== undefined && { detail }),
        });
        return { text: `Updated requirement ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'delete_requirement',
    {
      description:
        'Delete one requirement in this project. The user confirms in Emdash first. Deleting one also deletes its sub-requirements. Cannot be undone.',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      run(async () => {
        const missing = () => new Error(`No requirement ${id} in this project`);
        const items = await ctx.requirements.list(caller.projectId);
        const item = items.find((entry) => entry.id === id);
        if (!item) throw missing();
        await ctx.dispatch({
          kind: 'delete_requirement',
          id,
          title: item.title,
          childCount: directChildren(id, items).length,
        });
        const stillThere = (await ctx.requirements.list(caller.projectId)).some(
          (entry) => entry.id === id
        );
        if (!stillThere) throw missing();
        await ctx.requirements.remove(caller.projectId, id);
        return { text: `Deleted requirement ${item.id}: ${item.title}` };
      })
  );

  registerMemoryTools(server, ctx);

  // ── The user's screen ──────────────────────────────────────────────────────────
  server.registerTool(
    'open_file',
    {
      description: 'Show the user a file in Emdash, optionally at a line.',
      inputSchema: { path: z.string(), line: z.number().int().positive().optional() },
    },
    ({ path, line }) => dispatch({ kind: 'open', target: { type: 'file', path, line } })
  );

  server.registerTool(
    'open_diff',
    {
      description: "Show the user a changed file's diff in Emdash.",
      inputSchema: { path: z.string(), staged: z.boolean().optional() },
    },
    ({ path, staged }) => dispatch({ kind: 'open', target: { type: 'diff', path, staged } })
  );

  server.registerTool(
    'read_terminal',
    {
      description:
        "Read the end of a terminal in this task (the user's shells and other agents' terminals), e.g. to see an error the user mentions.",
      inputSchema: {
        name: z.string().optional().describe('Terminal or conversation name; omit for the latest'),
        lines: z.number().int().min(1).max(500).default(80),
      },
      annotations: { readOnlyHint: true },
    },
    ({ name, lines }) => dispatch({ kind: 'read_terminal', name, lines })
  );

  server.registerTool(
    'run_in_terminal',
    {
      description:
        'Run a command in a new terminal the user can watch (dev servers, long builds). The user confirms in Emdash.',
      inputSchema: { command: z.string().min(1) },
    },
    ({ command }) => dispatch({ kind: 'run_in_terminal', command })
  );

  server.registerTool(
    'notify',
    {
      description:
        'Send the user a system notification, e.g. when long work is done or a decision is needed.',
      inputSchema: { message: z.string().min(1), title: z.string().optional() },
    },
    ({ message, title }) => dispatch({ kind: 'notify', message, title })
  );

  // ── Driving the UI ─────────────────────────────────────────────────────────────
  server.registerTool(
    'list_commands',
    {
      description:
        'Commands you can run in the Emdash UI. Each line is the command id, whether it is enabled, disabled, or hidden, and its title.',
      annotations: { readOnlyHint: true },
    },
    () => dispatch({ kind: 'list_commands' })
  );

  server.registerTool(
    'run_command',
    {
      description:
        'Run one enabled command from list_commands. This does the same thing as choosing that command in the command palette.',
      inputSchema: {
        command_id: z.enum(NAVIGATION_COMMAND_IDS).describe('A command id from list_commands'),
      },
    },
    ({ command_id }) => dispatch({ kind: 'run_command', commandId: command_id })
  );

  // ── The built-in browser ───────────────────────────────────────────────────────
  server.registerTool(
    'browser_open',
    {
      description:
        "Open a URL in this task's built-in browser (e.g. the dev server) so you can check your work.",
      inputSchema: { url: z.string() },
    },
    ({ url }) => dispatch({ kind: 'browser', browser: { op: 'open', url } })
  );

  server.registerTool(
    'browser_snapshot',
    {
      description:
        'The page in the built-in browser as text: headings, text and interactive elements with refs for browser_click and browser_type.',
      annotations: { readOnlyHint: true },
    },
    () => dispatch({ kind: 'browser', browser: { op: 'snapshot' } })
  );

  server.registerTool(
    'browser_click',
    {
      description: 'Click an element by its ref from browser_snapshot.',
      inputSchema: { ref: z.string() },
    },
    ({ ref }) => dispatch({ kind: 'browser', browser: { op: 'click', ref } })
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Type into a field by its ref from browser_snapshot, replacing its content.',
      inputSchema: { ref: z.string(), text: z.string(), submit: z.boolean().optional() },
    },
    ({ ref, text, submit }) =>
      dispatch({ kind: 'browser', browser: { op: 'type', ref, text, submit } })
  );

  server.registerTool(
    'browser_press',
    {
      description: 'Press a key in the built-in browser, e.g. Enter, Escape, Tab, ArrowDown.',
      inputSchema: { key: z.string() },
    },
    ({ key }) => dispatch({ kind: 'browser', browser: { op: 'press', key } })
  );

  server.registerTool(
    'browser_screenshot',
    {
      description: 'A screenshot of the page in the built-in browser.',
      annotations: { readOnlyHint: true },
    },
    () => dispatch({ kind: 'browser', browser: { op: 'screenshot' } })
  );

  server.registerTool(
    'browser_console',
    {
      description: "Recent console messages and errors from the built-in browser's page.",
      annotations: { readOnlyHint: true },
    },
    () => dispatch({ kind: 'browser', browser: { op: 'console' } })
  );

  server.registerTool(
    'browser_network',
    {
      description:
        "Requests the built-in browser's page made (URL, type, status, duration), e.g. to find failing API calls.",
      annotations: { readOnlyHint: true },
    },
    () => dispatch({ kind: 'browser', browser: { op: 'network' } })
  );
}

const PROJECT_DECISION_RULES =
  "Record a choice that would be wrong in another task or worktree, an abandoned approach, or a fact that is not in the repo and that a later agent must follow. Do not record this task's steps, a file-by-file narration, work that is not done yet (that is the requirements list), an unsettled guess, or a secret.";

function agentMemorySource(caller: AgentCaller): MemorySource {
  return {
    kind: 'agent',
    providerId: caller.providerId,
    conversationId: caller.conversationId,
    taskId: caller.taskId,
  };
}

function registerMemoryTools(server: McpServer, ctx: AgentControlToolContext): void {
  const { caller } = ctx;
  const source = () => agentMemorySource(caller);
  const projectScope = (): MemoryScope => ({ kind: 'project', projectId: caller.projectId });

  server.registerTool(
    'add_project_memory',
    {
      description:
        'Append one decision for this project. The title is the decision and must stand alone. Detail is optional and only for the reason or what was abandoned. ' +
        PROJECT_DECISION_RULES +
        ' Change one with update_project_memory. The repository root and every worktree share this list.',
      inputSchema: {
        title: z.string().min(1),
        detail: z.string().optional(),
      },
    },
    ({ title, detail }) =>
      run(async () => {
        const item = await ctx.memory.add(projectScope(), { title, detail }, source());
        return { text: `Recorded project decision ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'list_project_memory',
    {
      description:
        "Read this project's decisions before you work. Newest first. Every title is included. The newest 40 also include the body; older rows are title, id, and date. Use get_project_memory for an older body. If a global decision and a project decision cover the same thing, follow the project record.",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => ({ text: formatMemoryList(await ctx.memory.list(projectScope())) }))
  );

  server.registerTool(
    'get_project_memory',
    {
      description:
        'Read one project decision in full, including the body. Pass the id from list_project_memory.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => ({ text: formatMemoryRecord(await ctx.memory.get(projectScope(), id)) }))
  );

  server.registerTool(
    'update_project_memory',
    {
      description:
        'Change the title or detail of one decision in this project. Pass at least one. An empty detail clears the text. It takes effect at once, without confirmation, and does not change who wrote it or when it was created.',
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(MEMORY_TITLE_MAX).optional(),
        detail: z.string().max(MEMORY_DETAIL_MAX).optional(),
      },
    },
    ({ id, title, detail }) =>
      run(async () => {
        if (title === undefined && detail === undefined) {
          throw new Error('Pass a title, a detail, or both');
        }
        const item = await ctx.memory.update(projectScope(), id, {
          ...(title !== undefined && { title }),
          ...(detail !== undefined && { detail }),
        });
        return { text: `Updated project decision ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'delete_project_memory',
    {
      description:
        'Delete one decision in this project. The user confirms in Emdash first. Cannot be undone.',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      run(async () => {
        const missing = () => new Error(`No decision ${id}`);
        const item = (await ctx.memory.list(projectScope())).find((entry) => entry.id === id);
        if (!item) throw missing();
        await ctx.dispatch({ kind: 'delete_project_memory', id, title: item.title });
        const stillThere = (await ctx.memory.list(projectScope())).some((entry) => entry.id === id);
        if (!stillThere) throw missing();
        await ctx.memory.remove(projectScope(), id);
        return { text: `Deleted project decision ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'add_global_memory',
    {
      description:
        'Append one decision that holds for every project on this Emdash. The title is the decision and must stand alone. Detail is optional and only for the reason or what was abandoned. Record something that would be wrong in another project, such as how commit messages are written here. Do not put a fact that only belongs to the current project. If you are not sure it belongs everywhere, do not record it. Do not write a secret. Change one with update_global_memory.',
      inputSchema: {
        title: z.string().min(1),
        detail: z.string().optional(),
      },
    },
    ({ title, detail }) =>
      run(async () => {
        const item = await ctx.memory.add({ kind: 'global' }, { title, detail }, source());
        return { text: `Recorded global decision ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'list_global_memory',
    {
      description:
        'Read decisions that hold for every project on this Emdash. Call this before list_project_memory. Newest first. Every title is included. The newest 40 also include the body; older rows are title, id, and date. Use get_global_memory for an older body.',
      annotations: { readOnlyHint: true },
    },
    () => run(async () => ({ text: formatMemoryList(await ctx.memory.list({ kind: 'global' })) }))
  );

  server.registerTool(
    'get_global_memory',
    {
      description:
        'Read one global decision in full, including the body. Pass the id from list_global_memory.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run(async () => ({
        text: formatMemoryRecord(await ctx.memory.get({ kind: 'global' }, id)),
      }))
  );

  server.registerTool(
    'update_global_memory',
    {
      description:
        'Change the title or detail of one decision that holds for every project. Pass at least one. An empty detail clears the text. It takes effect at once, without confirmation, and does not change who wrote it or when it was created.',
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(MEMORY_TITLE_MAX).optional(),
        detail: z.string().max(MEMORY_DETAIL_MAX).optional(),
      },
    },
    ({ id, title, detail }) =>
      run(async () => {
        if (title === undefined && detail === undefined) {
          throw new Error('Pass a title, a detail, or both');
        }
        const item = await ctx.memory.update({ kind: 'global' }, id, {
          ...(title !== undefined && { title }),
          ...(detail !== undefined && { detail }),
        });
        return { text: `Updated global decision ${item.id}: ${item.title}` };
      })
  );

  server.registerTool(
    'delete_global_memory',
    {
      description:
        'Delete one decision that holds for every project. The user confirms in Emdash first. Cannot be undone.',
      inputSchema: { id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      run(async () => {
        const missing = () => new Error(`No decision ${id}`);
        const item = (await ctx.memory.list({ kind: 'global' })).find((entry) => entry.id === id);
        if (!item) throw missing();
        await ctx.dispatch({ kind: 'delete_global_memory', id, title: item.title });
        const stillThere = (await ctx.memory.list({ kind: 'global' })).some(
          (entry) => entry.id === id
        );
        if (!stillThere) throw missing();
        await ctx.memory.remove({ kind: 'global' }, id);
        return { text: `Deleted global decision ${item.id}: ${item.title}` };
      })
  );
}
