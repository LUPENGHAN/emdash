import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type {
  ManagementDocumentReference,
  DocumentWrite,
} from '@core/features/coordination/api/documents';
import type { TaskResult } from '@core/features/coordination/api/types';
import type { TaskPullRequestInput } from '@core/features/source-control/api/task-pull-requests';
import { pendingAgentMessageSchema } from './pending-messages';

/**
 * Agent control: an MCP server ("emdash") that every local agent gets, so agents can
 * coordinate with each other and drive this app's UI. The main process authenticates
 * the calling conversation. Discovery, coordination and dispatch run in the background;
 * interactive actions go to the focused window through the same code paths as the UI.
 */

/** The conversation an MCP call comes from. */
export type AgentCaller = {
  conversationId: string;
  taskId: string;
  projectId: string;
  providerId: string;
  title: string;
  /** The task's working directory, when known. */
  cwd: string | null;
};

export type BrowserOp =
  | { op: 'open'; url: string }
  | { op: 'snapshot' }
  | { op: 'click'; ref: string }
  | { op: 'type'; ref: string; text: string; submit?: boolean }
  | { op: 'press'; key: string }
  | { op: 'screenshot' }
  | { op: 'console' }
  | { op: 'network' };

export type OpenTarget =
  | { type: 'file'; path: string; line?: number }
  | { type: 'diff'; path: string; staged?: boolean }
  | { type: 'url'; url: string };

/** UI commands an agent may list and run. Anything else stays on its own tool. */
export const NAVIGATION_COMMAND_IDS = [
  'app.toggleTheme',
  'app.navigateBack',
  'app.navigateForward',
  'app.commandPalette',
  'workbench.toggleLeftSidebar',
  'workbench.zenMode',
  'workbench.tabNext',
  'workbench.tabPrev',
  'workbench.tabReopen',
  'task.sidebarChanges',
  'task.sidebarFiles',
  'task.sidebarConversations',
  'task.viewTerminals',
  'task.toggleTerminalDrawer',
  'task.toggleRightSidebar',
  'task.openBrowser',
  'task.browserGoBack',
  'task.browserGoForward',
  'task.browserReload',
  'task.browserFocusUrl',
  'task.browserCopyUrl',
  'task.nextTask',
  'task.prevTask',
] as const;

export type NavigationCommandId = (typeof NAVIGATION_COMMAND_IDS)[number];

export type AgentControlAction =
  | ({ kind: 'create_pull_request' } & Omit<TaskPullRequestInput, 'taskId'> & { taskId?: string })
  | { kind: 'retry_pull_request'; taskId: string; requestId: string }
  | ({ kind: 'write_management_document'; coordinatorId?: string } & DocumentWrite)
  | { kind: 'read_management_document'; coordinatorId?: string; path: string; revision?: string }
  | { kind: 'cancel_pending_task'; taskId: string }
  | { kind: 'retry_task'; taskId: string }
  | { kind: 'take_over_task'; taskId: string; expectedOwner: string | null }
  | { kind: 'submit_task_result'; taskId?: string; requestId: string; result: TaskResult }
  | { kind: 'acknowledge_task_results'; eventIds: string[] }
  | {
      kind: 'review_task_result';
      taskId: string;
      accepted: boolean;
      note: string;
      resultVersion: number;
    }
  | { kind: 'list_projects'; query?: string }
  | { kind: 'get_main_agent_context' }
  | { kind: 'import_project'; requestId: string; repositoryUrl: string; name?: string }
  | { kind: 'get_task_status'; taskId: string }
  | { kind: 'add_work_item'; requestId: string; title: string; detail?: string }
  | {
      kind: 'update_work_item';
      workItemId: string;
      state: 'open' | 'in_progress' | 'waiting' | 'review' | 'done' | 'deferred' | 'cancelled';
      title?: string;
      detail?: string;
    }
  | { kind: 'create_checkpoint'; requestId: string; title: string }
  | {
      kind: 'set_main_agent_state';
      action: 'complete' | 'pause' | 'resume' | 'archive';
      note?: string;
    }
  | { kind: 'list_conversations'; scope: 'task' | 'project'; projectId?: string; taskId?: string }
  | {
      kind: 'create_conversation';
      providerId: string;
      model?: string;
      supplierId?: string;
      connection?: 'gateway' | 'official';
      effort?: string | null;
      prompt: string;
      ui?: 'terminal' | 'chat';
    }
  | { kind: 'send_message'; conversationId: string; text: string; requestId?: string }
  | { kind: 'handoff'; providerId: string; model?: string; note?: string }
  | { kind: 'suggest_task'; title: string; prompt: string }
  | {
      kind: 'create_task';
      name: string;
      projectId?: string;
      requestId?: string;
      projectGrants?: string[];
      dependsOn?: string[];
      documentRefs?: ManagementDocumentReference[];
      /** The explicit code base branch; absent resolves the target project baseline. */
      baseBranch?: string;
      /** An agent to start in the new task with this first message. */
      prompt?: string;
      providerId?: string;
      model?: string;
      supplierId?: string;
      connection?: 'gateway' | 'official';
      effort?: string | null;
      ui?: 'terminal' | 'chat';
    }
  | { kind: 'list_tasks'; includeArchived: boolean; projectId?: string }
  | { kind: 'archive_task'; taskId: string }
  | { kind: 'delete_task'; taskId: string }
  | { kind: 'delete_requirement'; id: string; title: string; childCount: number }
  | { kind: 'delete_project_memory'; id: string; title: string }
  | { kind: 'delete_global_memory'; id: string; title: string }
  | { kind: 'import_skill'; path: string; force: boolean }
  | { kind: 'open'; target: OpenTarget }
  | { kind: 'read_terminal'; name?: string; lines: number }
  | { kind: 'run_in_terminal'; command: string }
  | { kind: 'notify'; title?: string; message: string }
  | { kind: 'browser'; browser: BrowserOp }
  | { kind: 'list_commands' }
  | { kind: 'run_command'; commandId: NavigationCommandId };

export type AgentControlRequest = {
  requestId: string;
  /** The window that should act; others ignore the request. */
  rendererId: string;
  caller: AgentCaller;
  action: AgentControlAction;
};

/** What a tool returns to the agent: text, and optionally one image. */
export type AgentControlResult = {
  text: string;
  image?: { data: string; mimeType: string };
};

export const agentControlDomain = 'agentControl' as const;

export const agentControlContract = defineContract({
  pendingMessages: procedure({
    input: z.object({ taskId: z.string().min(1) }),
    output: z.array(pendingAgentMessageSchema),
  }),
  resolvePendingMessage: procedure({
    input: z.object({
      taskId: z.string().min(1),
      id: z.string().min(1),
      resolution: z.enum(['handled', 'dismissed']),
    }),
    output: z.void(),
  }),
  messagesChanged: eventStream({ key: z.void(), event: z.object({ taskId: z.string() }) }),
  requests: eventStream({ key: z.void(), event: z.custom<AgentControlRequest>() }),
  /** A window announces itself (and whether it has focus); repeat as a heartbeat. */
  register: procedure({
    input: z.object({ rendererId: z.string(), focused: z.boolean() }),
    output: z.void(),
  }),
  respond: procedure({
    input: z.object({
      requestId: z.string(),
      ok: z.boolean(),
      result: z.custom<AgentControlResult>().optional(),
      error: z.string().optional(),
    }),
    output: z.void(),
  }),
});
