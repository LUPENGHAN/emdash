import { AgentStatus } from '@emdash/ui/react/components';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import {
  ConversationSourceSuffix,
  conversationSourceTooltip,
  useConversationSource,
} from '@core/features/model-providers/contributions/browser/conversation-source';
import { MAX_CONVERSATION_TITLE_LENGTH } from '@core/primitives/conversations/api';
import type {
  TabBarItemProps,
  ResolvedTab,
} from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@core/primitives/workbench-shell/browser/tabs/tab-bar/generic-tab-item';
import { TabTitle } from '@core/primitives/workbench-shell/browser/tabs/tab-bar/tab-title';
import { ConversationCompactedHistoryBadge } from './conversation-compacted-history';
import { ConversationCostBadge } from './conversation-cost';
import { ConversationSubagentsBadge } from './conversation-subagents';
import type { ConversationTabResource } from './conversation-tab-resource';
import { handoffCommands } from './handoff';
import { restartConversationCommands } from './restart-conversation';
import { switchConversationUiCommands } from './switch-conversation-ui';

export const ConversationTabBarItem = observer(function ConversationTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<ConversationTabResource>) {
  const store = tab.resource.store;
  const title = formatConversationTitleForDisplay(store.data.providerId, store.data.title);
  const rawTitle = store.data.title ?? '';
  const source = useConversationSource(store.data);

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={title}
      tooltip={conversationSourceTooltip(title, source)}
      labelSlot={
        <>
          <TabTitle isActive={tab.isActive} isPreview={tab.isPreview}>
            {title}
            <ConversationSourceSuffix agentId={store.data.providerId} source={source} />
          </TabTitle>
          <ConversationCompactedHistoryBadge conversation={store.data} />
          <ConversationSubagentsBadge conversation={store.data} />
          <ConversationCostBadge conversation={store.data} />
        </>
      }
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
        ...switchConversationUiCommands(store.data),
        ...handoffCommands(store.data),
        ...restartConversationCommands(store.data),
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
