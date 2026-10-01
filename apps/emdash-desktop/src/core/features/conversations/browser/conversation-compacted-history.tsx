import { Dialog, RelativeTime, Spinner } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, History } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { openModal } from '@core/manifests/browser/modal-api';
import type { CompactedSegment, Conversation } from '@core/primitives/conversations/api';
import { defineModal } from '@core/primitives/modals/react';
import { cn } from '@core/primitives/styling/browser/cn';

/** Agents whose session files keep what came before a context compaction. */
const COMPACTING_PROVIDERS = new Set(['claude']);

function useCompactedSegments(conversation: Conversation) {
  return useQuery({
    queryKey: ['compactedSegments', conversation.id, conversation.sessionId ?? null],
    enabled: COMPACTING_PROVIDERS.has(conversation.providerId) && Boolean(conversation.sessionId),
    queryFn: async () =>
      (await getConversationsClient()).listCompactedSegments({ conversationId: conversation.id }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/**
 * How many times the agent compacted its context. A reopened chat only shows what came
 * after the last compaction; this opens everything before it, read from the session file.
 */
export const ConversationCompactedHistoryBadge = observer(
  function ConversationCompactedHistoryBadge({ conversation }: { conversation: Conversation }) {
    const { data: segments } = useCompactedSegments(conversation);
    if (!segments || segments.length === 0) return null;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void openModal('compactedHistoryModal', { conversation, segments });
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label="Earlier history"
        title={`Compacted ${segments.length}×: earlier history`}
        className="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-xs text-foreground-passive tabular-nums hover:bg-background-2 hover:text-foreground"
      >
        <History className="size-3" />
        {segments.length}
      </button>
    );
  }
);

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000)}k`;
}

function CompactedHistoryModal({
  conversation,
  segments,
}: {
  conversation: Conversation;
  segments: CompactedSegment[];
}) {
  // Newest first: the stretch just before the chat is the one usually wanted.
  const [open, setOpen] = useState<number | null>(segments.at(-1)?.index ?? null);
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Earlier history</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <p className="mb-3 text-xs text-foreground-muted">
          {`The agent compacted its context ${segments.length}× and kept only a summary of each stretch before; the chat shows what came after the last one. Read from its session file.`}
        </p>
        <ul className="flex max-h-[65vh] flex-col gap-1 overflow-y-auto">
          {[...segments].reverse().map((segment) => (
            <li key={segment.index} className="rounded-md border border-border">
              <button
                type="button"
                aria-expanded={open === segment.index}
                onClick={() => setOpen(open === segment.index ? null : segment.index)}
                className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-background-1"
              >
                <ChevronRight
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0 text-foreground-passive transition-transform',
                    open === segment.index && 'rotate-90'
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-xs text-foreground-passive">
                    <span className="font-medium text-foreground">
                      {`Part ${segment.index + 1}`}
                    </span>
                    {segment.endedAt ? <RelativeTime value={segment.endedAt} compact /> : null}
                    <span>{`${segment.turns} turns`}</span>
                    {segment.contextTokens ? (
                      <span>{`${formatTokens(segment.contextTokens)} context`}</span>
                    ) : null}
                  </span>
                  {segment.firstPrompt ? (
                    <span translate="no" className="truncate text-xs text-foreground-muted">
                      {segment.firstPrompt}
                    </span>
                  ) : null}
                </span>
              </button>
              {open === segment.index ? (
                <SegmentTranscript conversation={conversation} index={segment.index} />
              ) : null}
            </li>
          ))}
        </ul>
      </Dialog.Body>
    </>
  );
}

function SegmentTranscript({ conversation, index }: { conversation: Conversation; index: number }) {
  const [showSummary, setShowSummary] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['compactedSegment', conversation.id, conversation.sessionId ?? null, index],
    queryFn: async () =>
      (await getConversationsClient()).readCompactedSegment({
        conversationId: conversation.id,
        index,
      }),
    staleTime: Infinity,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }
  if (!data || data.turns.length === 0) {
    return <p className="px-3 pb-3 text-sm text-foreground-muted">Nothing was said in it.</p>;
  }
  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
      {data.turns.map((turn, turnIndex) => (
        <div key={turnIndex} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground-passive">
            {turn.role === 'user' ? 'You' : 'Agent'}
          </span>
          <div
            translate="no"
            className={cn(
              'rounded-md px-3 py-2 text-sm break-words whitespace-pre-wrap',
              turn.role === 'user' ? 'bg-background-1' : 'border border-border'
            )}
          >
            {turn.text}
          </div>
        </div>
      ))}
      {data.summary ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowSummary(!showSummary)}
            className="flex items-center gap-1 self-start text-xs font-medium text-foreground-passive hover:text-foreground"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', showSummary && 'rotate-90')}
            />
            Summary the agent kept
          </button>
          {showSummary ? (
            <div
              translate="no"
              className="rounded-md bg-background-1 px-3 py-2 text-xs break-words whitespace-pre-wrap text-foreground-muted"
            >
              {data.summary}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const compactedHistoryModal = defineModal<void>()({
  id: 'compactedHistoryModal',
  component: CompactedHistoryModal,
  size: 'lg',
});
