import { createConversationModal } from '../browser/create-conversation-modal';
import { restartConversationModal } from '../browser/restart-conversation';

export const conversationsBrowserContributions = {
  modalDefs: [createConversationModal, restartConversationModal],
} as const;
