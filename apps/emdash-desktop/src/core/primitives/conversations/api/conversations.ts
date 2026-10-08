import type { AgentProviderId } from '@emdash/plugins/agents/types';
import type { AgentStatus } from '@core/primitives/agents/api';

export const MAX_CONVERSATION_TITLE_LENGTH = 100;

export type ConversationType = 'pty' | 'acp';

export type InitialQueuePrompt = {
  text: string;
  hiddenContext?: string;
};

export type Conversation = {
  id: string;
  projectId: string;
  taskId: string;
  providerId: AgentProviderId;
  title: string;
  lastInteractedAt: string | null;
  autoApprove?: boolean;
  /**
   * The agent-facing session identifier. Null / absent means the conversation has never
   * successfully established a session.
   *
   * PTY conversations write a conversation.id placeholder only after the first fresh
   * process is spawned; provider hooks may later overwrite it with a native id. ACP
   * conversations store the id returned by newSession/loadSession.
   */
  sessionId?: string;
  /** Explicit selections keyed by provider-native ACP config ID. */
  options?: Record<string, string | boolean>;
  /** Model to pass to the TUI CLI. Absent or empty string means use the CLI default. */
  model?: string;
  /** Initial queued prompts to deliver on first ACP spawn. Only present before sessionId is set. */
  initialQueue?: InitialQueuePrompt[];
  isInitialConversation: boolean | null;
  /** Model provider source: provider id, null = the agent's own login, absent = agent default. */
  modelSource?: string | null;
  sourceModel?: string;
  agentStatus?: AgentStatus | null;
  agentStatusSeen?: boolean;
  /** Transport type: 'pty' (default) uses the terminal/PTY path; 'acp' uses the Agent Client Protocol. */
  type?: ConversationType;
};

export type ConversationEvent =
  | {
      type: 'changed';
      conversationId: string;
      taskId: string;
      projectId: string;
      changes: Partial<
        Pick<Conversation, 'lastInteractedAt' | 'title' | 'sessionId' | 'model' | 'autoApprove'>
      >;
    }
  | { type: 'created'; conversation: Conversation }
  | {
      type: 'deleted';
      conversationId: string;
      taskId: string;
      projectId: string;
    }
  | {
      type: 'agent-status-changed';
      conversationId: string;
      taskId: string;
      projectId: string;
      status: AgentStatus;
      seen: boolean;
    };

export type RenameConversationParams = {
  conversationId: string;
  newTitle: string;
};

/** Which host's cached conversation observations to list. */
export type HostConversationScope = {
  location: 'local' | 'remote';
  sshConnectionId: string | null;
};

/**
 * One cached host conversation observation for the machine page (spec §8): the full
 * registry row shape — task-linked and orphaned alike — unlike `Conversation`, which
 * only exists for task-linked records.
 */
export type HostConversationRow = {
  id: string;
  title: string;
  provider: string | null;
  type: string | null;
  projectId: string | null;
  taskId: string | null;
  /** Resolved link names for presentation; null when the link is absent or dangling. */
  projectName: string | null;
  taskName: string | null;
  workspacePath: string | null;
  lastSessionActivityAt: string | null;
  observedStatus: 'present' | 'missing' | null;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Live row carrying a deletion tombstone: removal pending until the sweep converges. */
  pendingRemoval: boolean;
};

export type CreateConversationParams = {
  id: string;
  projectId: string;
  taskId: string;
  provider: AgentProviderId;
  title: string;
  autoApprove?: boolean;
  /** Explicit selections keyed by provider-native ACP config ID. */
  options?: Record<string, string | boolean>;
  /** Model to pass to the TUI CLI. Absent or empty string means use the CLI default. */
  model?: string;
  isInitialConversation?: boolean;
  initialSize?: { cols: number; rows: number };
  initialPrompt?: string;
  initialQueue?: InitialQueuePrompt[];
  /** Transport type: 'pty' (default) uses the terminal/PTY path; 'acp' uses the Agent Client Protocol. */
  type?: ConversationType;
  /** Model provider to run on: provider id, null = the agent's own login, absent = default. */
  modelSource?: string | null;
  /** Model on that provider. */
  sourceModel?: string;
  /**
   * Resume this existing provider session instead of starting a new one. Used to adopt
   * sessions that were started outside Emdash (terminal: --resume; chat UI: session/load).
   */
  providerSessionId?: string;
};

/** A provider session found on disk that was not started by Emdash. */
export type ImportableSession = {
  providerId: 'claude' | 'codex' | 'opencode' | 'pi' | 'oh-my-pi' | 'cursor';
  sessionId: string;
  title: string;
  firstMessage: string | null;
  /** Epoch milliseconds of the last write to the session. */
  updatedAt: number;
  /** Directory the session ran in: one of the directories that were scanned. */
  cwd: string;
  /** Emdash workspace of that directory, for project-wide listings (checkout or worktree). */
  workspaceId?: string;
};

/**
 * How every handoff message starts. Agents title a session after its first message, so
 * titles starting with this are handoff messages, not names (the conversation keeps its own).
 */
export const HANDOFF_PROMPT_OPENER = '你在接手另一个 AI 编码助手';

/** A subagent an agent session started inside its own process (e.g. a Claude Task agent). */
/**
 * A session's token usage, and what it would cost at the vendors' API list prices
 * (the equivalent of a subscription's usage). `amount` is null when no model it used
 * has a known price; `unpricedModels` names those left out of it.
 */
export type SessionCost = {
  amount: number | null;
  currency: 'USD';
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  unpricedModels: string[];
  /**
   * Context compactions included in it. Their own requests are not recorded, so they
   * are estimated from the context they read and the summary they wrote.
   */
  compactions: number;
};

/**
 * A stretch of an agent session that ended in a context compaction. The agent kept only
 * a summary of it, and a reopened chat starts after the last compaction, so these are
 * read back from the agent's own session file.
 */
export type CompactedSegment = {
  index: number;
  startedAt: string | null;
  endedAt: string | null;
  /** The first thing the user asked in it. */
  firstPrompt: string | null;
  /** Spoken turns (user and agent) in it. */
  turns: number;
  trigger: 'auto' | 'manual' | null;
  /** The context's size when it was compacted. */
  contextTokens: number | null;
};

/** One compacted stretch, as said: turns (with the agent's tool calls in brief). */
export type CompactedSegmentTranscript = {
  turns: { role: 'user' | 'assistant'; text: string }[];
  /** The summary the agent carried on with. */
  summary: string | null;
};

export type SubagentSummary = {
  id: string;
  /** The agent's type, e.g. "Explore", or "agent" when it names none. */
  kind: string;
  /** What it was asked to do, when the agent recorded it. */
  description: string | null;
  status: 'running' | 'done';
  startedAt: string | null;
  updatedAt: string | null;
};

/** What a receiving agent gets when a conversation is handed off to it. */
export type HandoffPreparation = {
  /** First message for the receiving agent: short, pointing at the transcript file. */
  prompt: string;
  /** Workspace-relative transcript path, or null when the session had no readable text. */
  transcriptPath: string | null;
};
