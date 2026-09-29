import { Button, DropdownMenu, Tooltip } from '@emdash/ui/react/primitives';
import { ChevronDown, Globe, MessageSquarePlus, Plus, SquareTerminal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

/**
 * The "+" rendered after the last tab in the tab strip (browser-tab idiom).
 * Opens the create-conversation modal into this pane, so in a split layout it
 * doubles as "create the conversation here". Its menu opens a browser here too, or a
 * terminal, which otherwise only had shortcuts and the palette.
 */
export const NewConversationTabButton = observer(function NewConversationTabButton() {
  const { projectId, taskId } = useTaskViewContext();
  const { pane } = usePaneContext();
  const openCreateConversationModal = useOpenModal('createConversationModal');

  const handleCreateConversation = () => {
    void (async () => {
      const outcome = await openCreateConversationModal({ projectId, taskId });
      if (!outcome.success) return;
      const { conversationId, type } = outcome.data;
      if (type === 'acp') {
        pane.open('acp-chat', { conversationId, preview: false });
      } else {
        pane.open('conversation', { conversationId, preview: false });
      }
    })();
  };

  return (
    <div className="flex items-center">
      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button
            size="sm"
            icon
            variant="ghost"
            onClick={handleCreateConversation}
            aria-label="New conversation"
          >
            <Plus className="size-3.5" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>
          New Conversation <BoundShortcut command="task.newConversation" variant="keycaps" />
        </Tooltip.Content>
      </Tooltip.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <Button size="sm" icon variant="ghost" aria-label="Open in this pane">
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <DropdownMenu.Content className="min-w-52">
          <DropdownMenu.Item onClick={handleCreateConversation}>
            <MessageSquarePlus className="size-4" />
            <span className="flex-1">New conversation</span>
            <BoundShortcut command="task.newConversation" variant="keycaps" />
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => pane.open('browser', {}, { preview: false })}>
            <Globe className="size-4" />
            <span className="flex-1">New browser</span>
            <BoundShortcut command="task.openBrowser" variant="keycaps" />
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onClick={() => void getTaskComposition(projectId, taskId)?.openNewTerminal()}
          >
            <SquareTerminal className="size-4" />
            <span className="flex-1">New terminal</span>
            <BoundShortcut command="task.newTerminal" variant="keycaps" />
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
});
