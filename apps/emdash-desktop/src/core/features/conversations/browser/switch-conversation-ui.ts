import { toast } from '@emdash/ui/react/primitives';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { Conversation, ConversationType } from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';
import { currentChoice, restartConversation } from './restart-conversation';

/** Providers whose session ids resume both in the CLI (--resume) and in ACP (session/load). */
// Pi has no chat (ACP) adapter, so it stays terminal-only.
const SWITCHABLE_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'oh-my-pi']);

/** The UI a conversation would switch to: terminal ⇄ chat. */
export function switchTarget(conversation: Conversation): ConversationType {
  return conversation.type === 'acp' ? 'pty' : 'acp';
}

/**
 * Whether a conversation's session can be reopened in the other UI. Its session id must
 * be the provider's real one: chat (ACP) ids always are; for terminals, Claude is spawned
 * with `--session-id <conversation id>` so that placeholder is real, while other
 * providers only have a real id once captured.
 */
export function canSwitchConversationUi(conversation: Conversation): boolean {
  const sessionId = conversation.sessionId;
  if (!sessionId || !SWITCHABLE_PROVIDERS.has(conversation.providerId)) return false;
  if (conversation.type === 'acp') return true;
  return conversation.providerId === 'claude' || sessionId !== conversation.id;
}

/**
 * Reopens a conversation's session in the other UI, on the same provider, model and
 * approval setting: terminal via --resume, chat via session/load. See
 * `restartConversation`, which it shares with restarting on another provider.
 */
export async function switchConversationUi(
  conversation: Conversation
): Promise<{ conversationId: string; type: ConversationType }> {
  const type = switchTarget(conversation);
  const created = await restartConversation(conversation, currentChoice(conversation), {
    type,
    requireSession: true,
  });
  return { conversationId: created.id, type };
}

/** Tab-menu entry point: switch, then open the replacement where the old tab was. */
export async function switchConversationUiAndOpen(conversation: Conversation): Promise<void> {
  try {
    const { conversationId, type } = await switchConversationUi(conversation);
    getTaskComposition(conversation.projectId, conversation.taskId)?.paneLayout.open(
      type === 'acp' ? 'acp-chat' : 'conversation',
      { conversationId },
      { preview: false }
    );
  } catch (error) {
    log.error('switch conversation UI failed', error);
    toast.error(`Could not reopen this session: ${String(error)}`);
  }
}

/** Tab-menu command for a conversation, or none when it cannot switch. */
export function switchConversationUiCommands(conversation: Conversation | undefined) {
  if (!conversation || !canSwitchConversationUi(conversation)) return [];
  return [
    {
      id: 'conversation:switch-ui',
      label: switchTarget(conversation) === 'acp' ? 'Switch to chat UI' : 'Switch to terminal',
      group: 'edit',
      run: () => void switchConversationUiAndOpen(conversation),
    },
  ];
}
