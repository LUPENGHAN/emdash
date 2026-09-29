import { subagentTranscriptModal } from '../browser/conversation-subagents';
import { createConversationModal } from '../browser/create-conversation-modal';
import { restartConversationModal } from '../browser/restart-conversation';

export const conversationsBrowserContributions = {
  modalDefs: [createConversationModal, restartConversationModal, subagentTranscriptModal],
} as const;
