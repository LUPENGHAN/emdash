import { Popover } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import type { Conversation, SessionCost } from '@core/primitives/conversations/api';

/** Agents whose own session files record the tokens each request used. */
const COSTED_PROVIDERS = new Set(['claude', 'codex', 'pi', 'oh-my-pi']);

/** A conversation's token usage and its cost at API list prices, kept current. */
export function useConversationCost(conversation: Conversation | undefined) {
  return useQuery({
    queryKey: ['sessionCost', conversation?.id ?? null, conversation?.sessionId ?? null],
    enabled:
      !!conversation &&
      COSTED_PROVIDERS.has(conversation.providerId) &&
      Boolean(conversation.sessionId),
    queryFn: async () =>
      (await getConversationsClient()).sessionCost({ conversationId: conversation!.id }),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function formatCost(amount: number): string {
  if (amount < 1) return `$${amount.toFixed(2)}`;
  if (amount < 100) return `$${amount.toFixed(1)}`;
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/**
 * What the conversation's session has used, priced at the vendors' API list prices:
 * what it would cost on the API (a subscription is not billed this). A small amount on
 * the tab; the token breakdown on click.
 */
export const ConversationCostBadge = observer(function ConversationCostBadge({
  conversation,
}: {
  conversation: Conversation;
}) {
  const { data: cost } = useConversationCost(conversation);
  if (!cost) return null;
  const total = Object.values(cost.tokens).reduce((sum, count) => sum + count, 0);
  const label = cost.amount === null ? `${formatTokens(total)} tok` : formatCost(cost.amount);

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label="Equivalent API cost"
            className="flex h-5 shrink-0 items-center rounded px-1 text-xs text-foreground-passive tabular-nums hover:bg-background-2 hover:text-foreground"
          >
            {label}
          </button>
        }
      />
      <Popover.Content align="end" side="bottom" className="w-72">
        <CostDetails cost={cost} />
      </Popover.Content>
    </Popover.Root>
  );
});

function CostDetails({ cost }: { cost: SessionCost }) {
  const rows: [string, number][] = [
    ['Input', cost.tokens.input],
    ['Output', cost.tokens.output],
    ['Cache reads', cost.tokens.cacheRead],
    ['Cache writes', cost.tokens.cacheWrite],
  ];
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">Equivalent API cost</span>
        <span className="text-sm text-foreground tabular-nums">
          {cost.amount === null ? '—' : `US$${cost.amount.toFixed(2)}`}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {rows.map(([label, count]) => (
          <li key={label} className="flex justify-between text-foreground-muted">
            <span>{label}</span>
            <span className="tabular-nums">{formatTokens(count)} tokens</span>
          </li>
        ))}
      </ul>
      {cost.unpricedModels.length > 0 ? (
        <p className="text-foreground-passive">
          {`No list price for ${cost.unpricedModels.join(', ')}; their tokens are counted but not priced.`}
        </p>
      ) : null}
      <p className="text-foreground-passive">
        This session's tokens, including its subagents', at the vendors' API list prices
        (models.dev). A subscription is not billed this; a provider bills its own prices.
      </p>
    </div>
  );
}
