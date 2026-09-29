import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { toast } from '@emdash/ui/react/primitives';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { sendToConversation } from '@core/features/conversations/api/browser/send-to-conversation';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { openModal } from '@core/manifests/browser/modal-api';
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  type Conversation,
} from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';

const HANDOFF_TARGETS: { id: AgentProviderId; name: string }[] = [
  { id: 'claude' as AgentProviderId, name: 'Claude' },
  { id: 'codex' as AgentProviderId, name: 'Codex' },
  { id: 'opencode' as AgentProviderId, name: 'OpenCode' },
  { id: 'pi' as AgentProviderId, name: 'Pi' },
  { id: 'oh-my-pi' as AgentProviderId, name: 'Oh My Pi' },
  // A target only receives the handoff message, so it needs no transcript reader.
  { id: 'cursor' as AgentProviderId, name: 'Cursor' },
];

/**
 * Hands a conversation's work to another agent in the same task. The new-conversation
 * dialog opens on the target agent so its model and source can be chosen, with an
 * optional note and an optional summary written by the source agent first; on confirm the
 * new conversation (same UI type where the target has it) starts with a short handoff
 * message (the note, the summary, the recent turns, git state, and the path of a
 * text-only transcript it can read on demand). The source is kept, retitled "→ <agent>", so it can be picked up
 * again once its quota resets.
 */
export async function handOffConversation(
  conversation: Conversation,
  /** Preselected in the dialog; the user may pick another agent there. */
  target: { id: AgentProviderId; name: string }
): Promise<void> {
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const outcome = await openModal('createConversationModal', {
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    handoff: {
      fromConversationId: conversation.id,
      providerId: target.id,
      type: conversation.type ?? 'pty',
      title: conversation.title,
    },
  });
  if (!outcome.success) return;

  // The dialog may have switched agents; name the one that took over.
  const created = manager.conversations.get(outcome.data.conversationId)?.data;
  const targetName =
    HANDOFF_TARGETS.find((candidate) => candidate.id === created?.providerId)?.name ??
    created?.providerId ??
    target.name;
  const marker = ` → ${targetName}`;
  if (!conversation.title.endsWith(marker)) {
    const base = conversation.title.slice(0, MAX_CONVERSATION_TITLE_LENGTH - marker.length);
    await manager.renameConversation(conversation.id, `${base}${marker}`);
  }

  getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
    outcome.data.type === 'acp' ? 'acp-chat' : 'conversation',
    { conversationId: outcome.data.conversationId },
    { preview: false }
  );
}

/** Agents with a chat UI (ACP); the others run in a terminal. */
export const CHAT_CAPABLE_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'opencode',
  'oh-my-pi',
  'cursor',
]);

export function agentDisplayName(providerId: string): string {
  return HANDOFF_TARGETS.find((target) => target.id === providerId)?.name ?? providerId;
}

/**
 * Hands off without the dialog, for an agent that asked to (agent control): the target
 * and model are already chosen and the user confirmed. Same message, UI type rule and
 * retitling as the dialog path.
 */
export async function handOffConversationTo(
  conversation: Conversation,
  target: { providerId: string; model?: string; note?: string }
): Promise<Conversation> {
  const manager = conversationRegistry.get(conversation.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const { prompt } = await (
    await getConversationsClient()
  ).prepareHandoff({ conversationId: conversation.id });
  const text = target.note?.trim()
    ? `${prompt}\n\nNote from the previous agent: ${target.note.trim()}`
    : prompt;
  const type =
    (conversation.type ?? 'pty') === 'acp' && CHAT_CAPABLE_AGENTS.has(target.providerId)
      ? 'acp'
      : 'pty';
  const created = await manager.createConversation({
    id: crypto.randomUUID(),
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: target.providerId as AgentProviderId,
    title: conversation.title,
    type,
    // Terminals take --model; chat agents take it as their "model" config option.
    ...(target.model &&
      (type === 'acp' ? { options: { model: target.model } } : { model: target.model })),
    ...(type === 'acp' ? { initialQueue: [{ text }] } : { initialPrompt: text }),
  });
  const marker = ` → ${agentDisplayName(target.providerId)}`;
  if (!conversation.title.endsWith(marker)) {
    const base = conversation.title.slice(0, MAX_CONVERSATION_TITLE_LENGTH - marker.length);
    await manager.renameConversation(conversation.id, `${base}${marker}`);
  }
  getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
    type === 'acp' ? 'acp-chat' : 'conversation',
    { conversationId: created.id },
    { preview: false }
  );
  return created;
}

/** Tab-menu command: "Hand off", whose dialog picks the agent, model and source. */
export function handoffCommands(conversation: Conversation | undefined) {
  if (!conversation) return [];
  // Default to the first other agent: Claude and Codex hand off to each other.
  const target = HANDOFF_TARGETS.find((candidate) => candidate.id !== conversation.providerId);
  if (!target) return [];
  return [
    {
      id: 'conversation:handoff',
      label: 'Hand off',
      group: 'handoff',
      run: () => {
        void handOffConversation(conversation, target).catch((error: unknown) => {
          log.error('conversation handoff failed', error);
          toast.error(`Could not hand off: ${String(error)}`);
        });
      },
    },
  ];
}

/** How long a handoff waits for the source agent's summary before giving up. */
export const HANDOFF_SUMMARY_TIMEOUT_MS = 5 * 60_000;
const SUMMARY_POLL_MS = 2_000;

/**
 * Asks the source conversation's agent to write a handoff summary and waits until the
 * file is finished. Resolves with its path, or null when `stop()` says to go on without
 * it (the user skipped, or the wait timed out). Throws when the message cannot be sent.
 */
export async function collectHandoffSummary(
  source: Conversation,
  stop: () => boolean
): Promise<string | null> {
  const manager = conversationRegistry.get(source.taskId);
  if (!manager) throw new Error('The task is not loaded');
  const client = await getConversationsClient();
  const { summaryPath, prompt } = await client.requestHandoffSummary({
    conversationId: source.id,
  });
  await sendToConversation(manager, source, prompt);
  const deadline = Date.now() + HANDOFF_SUMMARY_TIMEOUT_MS;
  while (!stop() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SUMMARY_POLL_MS));
    const summary = await client
      .readHandoffSummary({ conversationId: source.id, summaryPath })
      .catch(() => null);
    if (summary) return summaryPath;
  }
  return null;
}
