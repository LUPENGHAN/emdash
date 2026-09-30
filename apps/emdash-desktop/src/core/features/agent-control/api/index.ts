import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

/**
 * Agent control: an MCP server ("emdash") that every local agent gets, so agents can
 * coordinate with each other and drive this app's UI. The main process authenticates
 * the calling conversation and hands each action to the window the user used last,
 * which carries it out with the same code paths as the UI.
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

export type AgentControlAction =
  | { kind: 'list_conversations'; scope: 'task' | 'project' }
  | {
      kind: 'create_conversation';
      providerId: string;
      model?: string;
      prompt: string;
      ui?: 'terminal' | 'chat';
    }
  | { kind: 'send_message'; conversationId: string; text: string }
  | { kind: 'handoff'; providerId: string; model?: string; note?: string }
  | { kind: 'suggest_task'; title: string; prompt: string }
  | {
      kind: 'create_task';
      name: string;
      /** The branch the new worktree starts from; the caller's own branch when absent. */
      baseBranch?: string;
      /** An agent to start in the new task with this first message. */
      prompt?: string;
      providerId?: string;
      ui?: 'terminal' | 'chat';
    }
  | { kind: 'open'; target: OpenTarget }
  | { kind: 'read_terminal'; name?: string; lines: number }
  | { kind: 'run_in_terminal'; command: string }
  | { kind: 'notify'; title?: string; message: string }
  | { kind: 'browser'; browser: BrowserOp };

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
