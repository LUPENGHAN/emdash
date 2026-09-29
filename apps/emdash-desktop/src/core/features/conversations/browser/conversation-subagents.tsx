import { Dialog, Popover, RelativeTime, Spinner } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { Workflow } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { openModal } from '@core/manifests/browser/modal-api';
import type { Conversation, SubagentSummary } from '@core/primitives/conversations/api';
import { defineModal } from '@core/primitives/modals/react';
import { cn } from '@core/primitives/styling/browser/cn';

/** Agents whose own session files record the subagents they start. */
const SUBAGENT_PROVIDERS = new Set(['claude', 'codex']);

/** A conversation's subagents, refreshed often while one runs. */
function useSubagents(conversation: Conversation) {
  return useQuery({
    queryKey: ['conversationSubagents', conversation.id, conversation.sessionId ?? null],
    enabled: SUBAGENT_PROVIDERS.has(conversation.providerId) && Boolean(conversation.sessionId),
    queryFn: async () =>
      (await getConversationsClient()).listSubagents({ conversationId: conversation.id }),
    refetchInterval: (query) =>
      query.state.data?.some((subagent) => subagent.status === 'running') ? 4_000 : 15_000,
  });
}

/**
 * The subagents a conversation's agent started inside its own process (Claude Code's
 * Task agents, Codex's spawned agents), which otherwise only show in its own output:
 * a count on the conversation's row, lit while any runs, opening their list.
 */
export const ConversationSubagentsBadge = observer(function ConversationSubagentsBadge({
  conversation,
}: {
  conversation: Conversation;
}) {
  const { data: subagents } = useSubagents(conversation);
  if (!subagents || subagents.length === 0) return null;
  const running = subagents.filter((subagent) => subagent.status === 'running').length;

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={
              running > 0 ? `${running} of ${subagents.length} subagents running` : 'Subagents'
            }
            className={cn(
              'flex h-5 shrink-0 items-center gap-1 rounded px-1 text-xs tabular-nums hover:bg-background-2',
              running > 0 ? 'text-foreground' : 'text-foreground-passive'
            )}
          >
            {running > 0 ? (
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            ) : null}
            <Workflow className="size-3" />
            {running > 0 ? `${running}/${subagents.length}` : subagents.length}
          </button>
        }
      />
      <Popover.Content align="end" side="bottom" className="w-80">
        <Popover.Header>
          <Popover.Title>Subagents</Popover.Title>
        </Popover.Header>
        <ul className="-mx-1 flex max-h-80 flex-col overflow-y-auto">
          {subagents.map((subagent) => (
            <li key={subagent.id}>
              <button
                type="button"
                className="flex w-full items-start gap-2 rounded px-1 py-1.5 text-left hover:bg-background-1"
                onClick={() =>
                  void openModal('subagentTranscriptModal', { conversation, subagent })
                }
              >
                <span
                  className={cn(
                    'mt-1.5 size-1.5 shrink-0 rounded-full',
                    subagent.status === 'running'
                      ? 'animate-pulse bg-emerald-500'
                      : 'bg-foreground-passive'
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-xs">
                    <span translate="no" className="font-medium text-foreground">
                      {subagent.kind}
                    </span>
                    <span className="text-foreground-passive">
                      {subagent.status === 'running' ? 'Running' : 'Done'}
                    </span>
                    {subagent.updatedAt ? (
                      <RelativeTime
                        value={subagent.updatedAt}
                        compact
                        className="ml-auto text-foreground-passive"
                      />
                    ) : null}
                  </span>
                  {subagent.description ? (
                    <span translate="no" className="truncate text-xs text-foreground-muted">
                      {subagent.description}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
});

function SubagentTranscriptModal({
  conversation,
  subagent,
}: {
  conversation: Conversation;
  subagent: SubagentSummary;
}) {
  const { data: turns, isLoading } = useQuery({
    queryKey: ['subagentTranscript', conversation.id, subagent.id],
    queryFn: async () =>
      (await getConversationsClient()).readSubagentTranscript({
        conversationId: conversation.id,
        subagentId: subagent.id,
      }),
    refetchInterval: subagent.status === 'running' ? 4_000 : false,
  });

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>
          <span translate="no">{subagent.kind}</span>
          {subagent.description ? (
            <span translate="no" className="font-normal text-foreground-muted">
              {' '}
              · {subagent.description}
            </span>
          ) : null}
        </Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !turns || turns.length === 0 ? (
          <p className="text-sm text-foreground-muted">Nothing recorded yet.</p>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {turns.map((turn, index) => (
              <div key={index} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground-passive">
                  {turn.role === 'user' ? 'Asked' : 'Answered'}
                </span>
                <div
                  translate="no"
                  className={cn(
                    'rounded-md px-3 py-2 text-sm whitespace-pre-wrap',
                    turn.role === 'user' ? 'bg-background-1' : 'border border-border'
                  )}
                >
                  {turn.text}
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog.Body>
    </>
  );
}

export const subagentTranscriptModal = defineModal<void>()({
  id: 'subagentTranscriptModal',
  component: SubagentTranscriptModal,
});
