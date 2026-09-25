import { AgentStatus } from '@emdash/ui/react/components';
import { toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { MAX_CONVERSATION_TITLE_LENGTH } from '@core/primitives/conversations/api';
import { log } from '@core/primitives/logging/browser/logger';
import type {
  TabBarItemProps,
  ResolvedTab,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@core/primitives/workbench-shell/browser/tabs/tab-bar/generic-tab-item';
import type { ConversationTabResource } from './conversation-tab-resource';
import { canSwitchToChatUi, switchConversationToChatUi } from './switch-to-chat-ui';

export const ConversationTabBarItem = observer(function ConversationTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<ConversationTabResource>) {
  const store = tab.resource.store;
  const title = formatConversationTitleForDisplay(store.data.providerId, store.data.title);
  const rawTitle = store.data.title ?? '';

  const switchToChatUi = async () => {
    const { projectId, taskId } = store.data;
    try {
      const conversationId = await switchConversationToChatUi(store.data);
      getTaskComposition(projectId, taskId)?.paneLayout.open(
        'acp-chat',
        { conversationId },
        { preview: false }
      );
    } catch (error) {
      log.error('switch conversation to chat UI failed', error);
      toast.error(`Could not open this session in the chat UI: ${String(error)}`);
    }
  };

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={title}
      preSlot={<AgentIcon id={store.data.providerId} size={16} />}
      statusSlot={
        <span className="transition-opacity group-hover:opacity-0">
          <AgentStatus status={store.indicatorStatus} />
        </span>
      }
      kindCommands={[
        {
          id: 'conversation:rename',
          label: 'Rename',
          group: 'edit',
          shortcut: { commandId: 'workbench.tabRename' },
          run: () => host.requestRename(tab.tabId),
        },
        ...(canSwitchToChatUi(store.data)
          ? [
              {
                id: 'conversation:switch-to-chat-ui',
                label: 'Switch to chat UI',
                group: 'edit',
                run: () => void switchToChatUi(),
              },
            ]
          : []),
      ]}
      renameValue={rawTitle}
      renameMaxLength={MAX_CONVERSATION_TITLE_LENGTH}
    />
  );
});

export const ConversationTabBarItemDragPreview = observer(
  function ConversationTabBarItemDragPreview({
    tab,
  }: {
    tab: ResolvedTab<ConversationTabResource>;
  }) {
    const store = tab.resource.store;
    const label = formatConversationTitleForDisplay(store.data.providerId, store.data.title);
    return (
      <GenericTabDragPreview
        preSlot={
          store.data.providerId ? (
            <AgentIcon id={store.data.providerId} size={16} className="shrink-0" />
          ) : undefined
        }
        label={label}
      />
    );
  }
);
