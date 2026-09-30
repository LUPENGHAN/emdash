import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UsageLimits } from '@core/features/model-providers/api';
import type { AgentCaller, AgentControlAction, AgentControlResult } from '../api';

/** Agents Emdash can start; the ids tools accept for `agent`. */
export const AGENT_IDS = ['claude', 'codex', 'opencode', 'pi', 'oh-my-pi', 'cursor'] as const;
const agentSchema = z.enum(AGENT_IDS);

export type AgentControlToolContext = {
  caller: AgentCaller;
  dispatch: (action: AgentControlAction) => Promise<AgentControlResult>;
  usageLimits: () => Promise<UsageLimits>;
};

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
