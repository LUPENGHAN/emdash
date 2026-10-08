import { toast } from '@emdash/ui/react/primitives';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { Conversation, ConversationType } from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';
import { currentChoice, restartConversation, resumableSessionId } from './restart-conversation';

/** Providers whose session ids resume both in the CLI (--resume) and in ACP (session/load). */
// Pi has no chat (ACP) adapter, so it stays terminal-only.
const SWITCHABLE_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'oh-my-pi', 'cursor']);
/** Providers whose session must be moved between their UIs' stores on this computer. */
const LOCAL_ONLY_PROVIDERS = new Set(['cursor']);

/** The UI a conversation would switch to: terminal ⇄ chat. */
export function switchTarget(conversation: Conversation): ConversationType {
  return conversation.type === 'acp' ? 'pty' : 'acp';
}

/** Whether a conversation can move to the other UI (resuming its session if it has one). */
export function canSwitchConversationUi(conversation: Conversation): boolean {
  if (!SWITCHABLE_PROVIDERS.has(conversation.providerId)) return false;
  return (
    !LOCAL_ONLY_PROVIDERS.has(conversation.providerId) ||
    getProjectSshConnectionId(conversation.projectId) === undefined
  );
}

/**
 * Reopens a conversation in the other UI, on the same provider, model and approval
 * setting: its session resumes (terminal via --resume, chat via session/load), or, when
 * it has none yet (nothing sent), a new one starts there. See `restartConversation`,
 * which it shares with restarting on another provider.
 */
export async function switchConversationUi(
  conversation: Conversation
): Promise<{ conversationId: string; type: ConversationType }> {
  const type = switchTarget(conversation);
  const created = await restartConversation(conversation, currentChoice(conversation), { type });
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
      label:
        resumableSessionId(conversation) === null
          ? switchTarget(conversation) === 'acp'
            ? 'Switch to chat UI (new session)'
            : 'Switch to terminal (new session)'
          : switchTarget(conversation) === 'acp'
            ? 'Switch to chat UI'
            : 'Switch to terminal',
      group: 'edit',
      run: () => void switchConversationUiAndOpen(conversation),
    },
  ];
}
