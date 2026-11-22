import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  documentPathSchema,
  documentRevisionSchema,
  documentWriteSchema,
} from '@core/features/coordination/api/documents';
import { taskResultSchema } from '@core/features/coordination/api/types';
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
 * need interactive UI keep their confirmation paths; authorized coordination runs in the background.
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
    'list_projects',
    {
      description:
        'Discover authorized Emdash projects with stable IDs, host availability and code baseline. Linked projects organize context; permissions are enforced separately.',
      inputSchema: { query: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => dispatch({ kind: 'list_projects', ...(query && { query }) })
  );

  server.registerTool(
    'get_main_agent_context',
    {
      description:
        'Main agent: read the current workspace plus linked-project requirements, project decisions and global memory in one snapshot before planning work.',
      annotations: { readOnlyHint: true },
    },
    () => dispatch({ kind: 'get_main_agent_context' })
  );

  server.registerTool(
    'import_project',
    {
      description:
        'Main agent: clone a repository that is not yet in Emdash, register it as a visible project and link it to this workspace. Reuse request_id when retrying.',
      inputSchema: {
        request_id: z.uuid(),
        repository_url: z.string().min(1),
        name: z.string().trim().min(1).max(100).optional(),
        directory: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[a-zA-Z0-9._-]+$/)
          .optional(),
      },
    },
    ({ request_id, repository_url, name, directory }) =>
      dispatch({
        kind: 'import_project',
        requestId: request_id,
        repositoryUrl: repository_url,
        ...(name && { name }),
        ...(directory && { directory }),
      })
  );
  server.registerTool(
    'retry_project_import',
    {
      description:
        'Main agent: retry a failed or cancelled repository import with its frozen URL, name and target directory.',
      inputSchema: { request_id: z.uuid() },
    },
    ({ request_id }) => dispatch({ kind: 'retry_project_import', requestId: request_id })
  );
  server.registerTool(
    'cancel_project_import',
    {
      description: 'Main agent: cancel a repository import that is currently cloning.',
      inputSchema: { request_id: z.uuid() },
    },
    ({ request_id }) => dispatch({ kind: 'cancel_project_import', requestId: request_id })
  );
  server.registerTool(
    'get_task_status',
    {
      description:
        'Read an authorized task status, main agent ownership, result version and waiting reason.',
      inputSchema: { task_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    ({ task_id }) => dispatch({ kind: 'get_task_status', taskId: task_id })
  );

  server.registerTool(
    'add_work_item',
    {
      description:
        'Main agent: add a workspace work item for an outcome, analysis question or coordination item. This does not create a Project requirement or a code task. Reuse request_id for retries.',
      inputSchema: {
        request_id: z.uuid(),
        title: z.string().trim().min(1).max(200),
        detail: z.string().max(20_000).optional(),
      },
    },
    ({ request_id, title, detail }) =>
      dispatch({ kind: 'add_work_item', requestId: request_id, title, ...(detail && { detail }) })
  );

  server.registerTool(
    'update_work_item',
    {
      description:
        'Main agent: update a workspace work item independently from Project requirements, task results and workspace completion.',
      inputSchema: {
        work_item_id: z.string().min(1),
        state: z.enum([
          'open',
          'in_progress',
          'waiting',
          'review',
          'done',
          'deferred',
          'cancelled',
        ]),
        title: z.string().trim().min(1).max(200).optional(),
        detail: z.string().max(20_000).optional(),
      },
    },
    ({ work_item_id, state, title, detail }) =>
      dispatch({
        kind: 'update_work_item',
        workItemId: work_item_id,
        state,
        ...(title && { title }),
        ...(detail !== undefined && { detail }),
      })
  );

  server.registerTool(
    'create_optimization_run',
    {
      description:
        'Main agent: capture one user-triggered experience improvement. This creates a workspace work item and a durable optimization run; it does not grant push, merge, deploy, data deletion or permission changes. Reuse request_id for retries.',
      inputSchema: {
        request_id: z.uuid(),
        conversation_id: z.string().min(1),
        suggestion_id: z.uuid().optional(),
        execution_mode: z.enum(['automatic', 'proposal-first']),
        experience_confirmation: z.enum(['user', 'acceptance-criteria']),
        objective: z.string().trim().min(1).max(20_000),
        observed_problem: z.string().trim().min(1).max(20_000),
        surface: z.string().max(500).optional(),
        route: z.string().max(2_000).optional(),
        selected_entity_refs: z.array(z.string().max(1_000)).max(50).default([]),
        screenshot_ref: z.string().max(2_000).optional(),
        log_refs: z.array(z.string().max(2_000)).max(20).default([]),
        live_revision: z.string().optional(),
        app_version: z.string(),
        risk_level: z.enum(['low', 'medium', 'high']),
        risk_reasons: z.array(z.string().trim().min(1)).default([]),
        requires_user_confirmation: z.boolean(),
      },
    },
    ({
      request_id,
      conversation_id,
      suggestion_id,
      execution_mode,
      experience_confirmation,
      objective,
      observed_problem,
      surface,
      route,
      selected_entity_refs,
      screenshot_ref,
      log_refs,
      live_revision,
      app_version,
      risk_level,
      risk_reasons,
      requires_user_confirmation,
    }) =>
      dispatch({
        kind: 'create_optimization_run',
        requestId: request_id,
        conversationId: conversation_id,
        ...(suggestion_id && { suggestionId: suggestion_id }),
        executionMode: execution_mode,
        experienceConfirmation: experience_confirmation,
        objective,
        observedProblem: observed_problem,
        ...(surface && { surface }),
        ...(route && { route }),
        selectedEntityRefs: selected_entity_refs,
        ...(screenshot_ref && { screenshotRef: screenshot_ref }),
        logRefs: log_refs,
        ...(live_revision && { liveRevision: live_revision }),
        appVersion: app_version,
        risk: {
          level: risk_level,
          reasons: risk_reasons,
          requiresUserConfirmation: requires_user_confirmation,
        },
      })
  );

  server.registerTool(
    'transition_optimization_run',
    {
      description:
        'Main agent: move an optimization through its validated state machine. Invalid jumps, unvalidated application and unapproved high-risk work are rejected.',
      inputSchema: {
        run_id: z.uuid(),
        state: z.enum([
          'captured',
          'investigating',
          'planning',
          'waiting_for_approval',
          'implementing',
          'validating',
          'ready_to_apply',
          'applying',
          'observing',
          'accepted',
          'blocked',
          'failed',
          'rolled_back',
        ]),
        reason: z.string().max(20_000).optional(),
        technical_validation_passed: z.boolean().optional(),
        user_decision: z.enum(['pending', 'accepted', 'continue', 'rollback']).optional(),
        note: z.string().max(20_000).optional(),
      },
    },
    ({ run_id, state, reason, technical_validation_passed, user_decision, note }) =>
      dispatch({
        kind: 'transition_optimization_run',
        runId: run_id,
        state,
        ...(reason && { reason }),
        ...(technical_validation_passed !== undefined && {
          technicalValidationPassed: technical_validation_passed,
        }),
        ...(user_decision && { userDecision: user_decision }),
        ...(note && { note }),
      })
  );

  server.registerTool(
    'add_optimization_suggestion',
    {
      description:
        'Main agent: add a local, evidence-backed improvement suggestion. A suggestion is not a Project TODO and never executes until the user accepts it.',
      inputSchema: {
        request_id: z.uuid(),
        fingerprint: z.string().min(1),
        title: z.string().trim().min(1).max(200),
        observed_pattern: z.string().trim().min(1).max(20_000),
        proposed_outcome: z.string().trim().min(1).max(20_000),
        evidence_refs: z.array(z.string().max(2_000)).max(50).default([]),
        confidence: z.enum(['low', 'medium', 'high']),
      },
    },
    ({
      request_id,
      fingerprint,
      title,
      observed_pattern,
      proposed_outcome,
      evidence_refs,
      confidence,
    }) =>
      dispatch({
        kind: 'add_optimization_suggestion',
        requestId: request_id,
        fingerprint,
        title,
        observedPattern: observed_pattern,
        proposedOutcome: proposed_outcome,
        evidenceRefs: evidence_refs,
        confidence,
      })
  );

  server.registerTool(
    'update_optimization_suggestion',
    {
      description:
        'Main agent: dismiss or expire an optimization suggestion without changing TODOs.',
      inputSchema: {
        suggestion_id: z.uuid(),
        state: z.enum(['dismissed', 'expired']),
      },
    },
    ({ suggestion_id, state }) =>
      dispatch({ kind: 'update_optimization_suggestion', suggestionId: suggestion_id, state })
  );

  server.registerTool(
    'create_checkpoint',
    {
      description:
        'Ongoing main agent: record a named checkpoint without completing the workspace or resetting its conversations.',
      inputSchema: {
        request_id: z
          .uuid()
          .describe('Stable idempotency key; reuse it when retrying this action.'),
        title: z.string().trim().min(1).max(200),
      },
    },
    ({ request_id, title }) => dispatch({ kind: 'create_checkpoint', requestId: request_id, title })
  );

  server.registerTool(
    'set_main_agent_state',
    {
      description:
        'Main agent lifecycle: complete a finite workspace, pause or resume an ongoing workspace, or archive either. Completion is rejected while code tasks or work items remain active.',
      inputSchema: {
        action: z.enum(['complete', 'pause', 'resume', 'archive', 'restore']),
        note: z.string().max(20_000).optional(),
      },
    },
    ({ action, note }) => dispatch({ kind: 'set_main_agent_state', action, ...(note && { note }) })
  );

  server.registerTool(
    'list_conversations',
    {
      description:
        'Conversations in this task (or the whole project) with their agent, model and status (working, waiting for input, idle).',
      inputSchema: {
        scope: z.enum(['task', 'project']).default('task'),
        project_id: z.string().min(1).optional(),
        task_id: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ scope, project_id, task_id }) =>
      dispatch({
        kind: 'list_conversations',
        scope,
        ...(project_id && { projectId: project_id }),
        ...(task_id && { taskId: task_id }),
      })
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
        supplier_id: z.string().min(1).optional(),
        connection: z.enum(['gateway', 'official']).optional(),
        effort: z.string().min(1).nullable().optional(),
        ui: z.enum(['terminal', 'chat']).optional(),
      },
    },
    ({ agent, prompt, model, supplier_id, connection, effort, ui }) =>
      dispatch({
        kind: 'create_conversation',
        providerId: agent,
        prompt,
        model,
        supplierId: supplier_id,
        connection,
        effort,
        ui,
      })
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to an authorized conversation. Get IDs from list_conversations and reuse request_id when retrying. ACP messages queue in the background; terminal messages retain a pending state when automatic delivery cannot be confirmed.',
      inputSchema: {
        conversation_id: z.string(),
        text: z.string().min(1),
        request_id: z.string().min(1).optional(),
      },
    },
    ({ conversation_id, text, request_id }) =>
      dispatch({
        kind: 'send_message',
        conversationId: conversation_id,
        text,
        ...(request_id && { requestId: request_id }),
      })
  );

  server.registerTool(
    'handoff',
    {
      description:
        "Hand this conversation's work to another agent: it starts with the original ask, your last reply, the git state and a transcript path. Use when your quota is nearly out or another agent suits the work better. Task creation and startup run in the background. Reuse request_id when retrying. With depends_on, returns a blocked plan without a worktree until prerequisite results are accepted.",
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
        "Create a git worktree through Emdash, as a task in the target project: use this instead of `git worktree add` (or a worktree tool of your own), so the worktree lands where Emdash keeps them and the user can see and review its code in Emdash. Returns the worktree's path and branch; work there yourself, or pass `prompt` to start an agent in it. Task creation and startup run in the background. Reuse request_id when retrying.",
      inputSchema: {
        depends_on: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Prerequisite task IDs; resources and agent start wait until their results are accepted'
          ),
        project_grants: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Explicit project permissions for this worker; cannot exceed your own permissions'
          ),
        project_id: z
          .string()
          .optional()
          .describe('Target project ID; omit for the calling project'),
        request_id: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Stable request ID; reuse exactly when retrying the same task'),
        name: z.string().min(1).max(80).describe('Task name, e.g. "fix-login-timeout"'),
        optimization_run_id: z
          .string()
          .uuid()
          .optional()
          .describe('Optimization run this code task implements, when applicable'),
        document_refs: z
          .array(
            z.object({
              coordinator_id: z.string().min(1).optional(),
              path: documentPathSchema,
              revision: documentRevisionSchema.optional(),
            })
          )
          .max(16)
          .optional()
          .describe(
            'Freeze selected management documents as task context; omit coordinator_id for your responsible main agent. Uncommitted disk versions must still match at dispatch.'
          ),
        base_branch: z
          .string()
          .optional()
          .describe('Code branch to start from; omit for the target project baseline'),
        prompt: z
          .string()
          .optional()
          .describe('Start an agent in the new task with this first message'),
        agent: agentSchema.optional().describe('Agent for `prompt`; omit for yourself'),
        model: z
          .string()
          .min(1)
          .optional()
          .describe('Public model alias, or supplier model when supplier_id is specified'),
        supplier_id: z
          .string()
          .min(1)
          .optional()
          .describe('Configured API supplier ID; used through the gateway'),
        connection: z.enum(['gateway', 'official']).optional(),
        effort: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe('Supported reasoning effort; null follows the adapter default'),
        ui: z.enum(['terminal', 'chat']).optional(),
      },
    },
    ({
      name,
      project_id,
      project_grants,
      depends_on,
      document_refs,
      request_id,
      optimization_run_id,
      base_branch,
      prompt,
      agent,
      model,
      supplier_id,
      connection,
      effort,
      ui,
    }) =>
      dispatch({
        kind: 'create_task',
        name,
        ...(project_id && { projectId: project_id }),
        ...(project_grants && { projectGrants: project_grants }),
        ...(depends_on && { dependsOn: depends_on }),
        ...(document_refs && {
          documentRefs: document_refs.map(({ coordinator_id, path, revision }) => ({
            coordinatorId: coordinator_id,
            path,
            revision,
          })),
        }),
        ...(request_id && { requestId: request_id }),
        ...(optimization_run_id && { optimizationRunId: optimization_run_id }),
        ...(base_branch && { baseBranch: base_branch }),
        ...(prompt && { prompt, ...(agent && { providerId: agent }) }),
        ...(model && { model }),
        ...(supplier_id && { supplierId: supplier_id }),
        ...(connection && { connection }),
        ...(effort !== undefined && { effort }),
        ...(ui && { ui }),
      })
  );

  server.registerTool(
    'write_management_document',
    {
      description:
        'Designated main conversation: create or update a management text document in its configured storage, including a different repository or host. Paths are relative to management storage. To update, read first and pass its returned disk version as expected_revision. Omit expected_revision only for a new file. This does not commit or push documents. Workers cannot write shared management documents.',
      inputSchema: {
        coordinator_id: z.string().min(1).optional(),
        path: documentWriteSchema.shape.path,
        content: documentWriteSchema.shape.content,
        expected_revision: documentWriteSchema.shape.expectedRevision,
      },
    },
    ({ coordinator_id, path, content, expected_revision }) =>
      dispatch({
        kind: 'write_management_document',
        coordinatorId: coordinator_id,
        path,
        content,
        expectedRevision: expected_revision,
      })
  );

  server.registerTool(
    'read_management_document',
    {
      description:
        'Read an authorized main agent management document as text with its version. Paths are relative to its management workspace. Omit coordinator_id for your responsible main agent. Workers can read only explicitly attached snapshots or documents permitted by their project grants. Attached snapshots remain readable after edits. Other disk versions are valid only while the saved content is unchanged; use a full commit ID for historical content.',
      inputSchema: {
        coordinator_id: z.string().min(1).optional(),
        path: documentPathSchema,
        revision: documentRevisionSchema.optional(),
      },
    },
    ({ coordinator_id, path, revision }) =>
      dispatch({ kind: 'read_management_document', coordinatorId: coordinator_id, path, revision })
  );

  server.registerTool(
    'take_over_task',
    {
      description:
        'Main agent: explicitly adopt an unowned code task or take it over from another main agent. Read get_task_status first and pass its coordinatorId as expected_owner, or null when unowned. The branch and running worker are preserved.',
      inputSchema: { task_id: z.string().min(1), expected_owner: z.string().nullable() },
    },
    ({ task_id, expected_owner }) =>
      dispatch({ kind: 'take_over_task', taskId: task_id, expectedOwner: expected_owner })
  );

  server.registerTool(
    'retry_task',
    {
      description:
        'Retry startup of a saved delegated task by task ID after fixing its failure. Any conversation in its responsible main-agent task (or its original caller when unowned) can retry. Preserves the task, branch, conversation, model configuration and document snapshots; never creates a replacement task.',
      inputSchema: { task_id: z.string().min(1) },
    },
    ({ task_id }) => dispatch({ kind: 'retry_task', taskId: task_id })
  );

  server.registerTool(
    'create_pull_request',
    {
      description:
        'Push a code task branch and create or reuse its pull request. Main agents may act on their own assigned tasks; task agents may act only on themselves. Supply a stable request_id and reuse it on retries. Source commit, push destination and PR target are frozen before pushing. Defaults come from the target project settings. No automatic merge.',
      inputSchema: {
        task_id: z.string().min(1).optional(),
        request_id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(1000),
        body: z.string().max(100_000).optional(),
        draft: z.boolean().default(false),
        source_branch: z.string().min(1).optional(),
        push_remote: z.string().min(1).optional(),
        target_repository: z.string().min(1).optional(),
        target_branch: z.string().min(1).optional(),
        push: z
          .boolean()
          .optional()
          .describe(
            'Default true. Set false to use and freeze the existing remote branch commit without pushing local changes.'
          ),
      },
    },
    ({
      task_id,
      request_id,
      title,
      body,
      draft,
      source_branch,
      push_remote,
      target_repository,
      target_branch,
      push,
    }) =>
      dispatch({
        kind: 'create_pull_request',
        taskId: task_id,
        requestId: request_id,
        title,
        body,
        draft,
        sourceBranch: source_branch,
        pushRemote: push_remote,
        repositoryUrl: target_repository,
        base: target_branch,
        push,
      })
  );
  server.registerTool(
    'retry_pull_request',
    {
      description:
        'Resume a saved task PR request using its frozen source, push remote and target. Inspect get_task_status.pullRequests for the request ID, phase, error and result. The current main agent or the task itself may retry; this never resolves defaults again or automatically merges.',
      inputSchema: { task_id: z.string().min(1), request_id: z.string().min(1).max(200) },
    },
    ({ task_id, request_id }) =>
      dispatch({ kind: 'retry_pull_request', taskId: task_id, requestId: request_id })
  );

  server.registerTool(
    'cancel_pending_task',
    {
      description:
        'Main agent: cancel a task waiting for prerequisites, before startup has been admitted. Keeps its history; does not stop a running task.',
      inputSchema: { task_id: z.string().min(1) },
    },
    ({ task_id }) => dispatch({ kind: 'cancel_pending_task', taskId: task_id })
  );

  server.registerTool(
    'submit_task_result',
    {
      description:
        'Submit a delegated task result to its main agent. Include actual checks and unresolved issues. This requests review; it does not mark the task complete.',
      inputSchema: {
        task_id: z.string().optional(),
        request_id: z.string().min(1),
        result: taskResultSchema,
      },
    },
    ({ task_id, request_id, result }) =>
      dispatch({ kind: 'submit_task_result', taskId: task_id, requestId: request_id, result })
  );
  server.registerTool(
    'acknowledge_task_results',
    {
      description:
        'Main agent: acknowledge received result event IDs before taking follow-up actions. Repeated acknowledgment is safe.',
      inputSchema: { event_ids: z.array(z.string()).min(1) },
    },
    ({ event_ids }) => dispatch({ kind: 'acknowledge_task_results', eventIds: event_ids })
  );
  server.registerTool(
    'review_task_result',
    {
      description:
        'Main agent: accept or request changes after checking the task result, diff and evidence. Acceptance marks the task complete.',
      inputSchema: {
        task_id: z.string(),
        result_version: z.number().int().positive(),
        accepted: z.boolean(),
        note: z.string().trim().min(1),
      },
    },
    ({ task_id, accepted, note, result_version }) =>
      dispatch({
        kind: 'review_task_result',
        taskId: task_id,
        accepted,
        note,
        resultVersion: result_version,
      })
  );

  // ── Tasks in this project ──────────────────────────────────────────────────────
  server.registerTool(
    'list_tasks',
    {
      description:
        'Tasks in this project: id, name, branch, status, whether an agent is running in it, and when it was created. Yours is marked. Use the id with archive_task or delete_task.',
      inputSchema: {
        include_archived: z.boolean().default(false),
        project_id: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ include_archived, project_id }) =>
      dispatch({
        kind: 'list_tasks',
        includeArchived: include_archived,
        ...(project_id && { projectId: project_id }),
      })
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
