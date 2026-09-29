import { Popover, Spinner } from '@emdash/ui/react/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import type { AgentUsage, UsageLimits, UsageWindow } from '@core/features/model-providers/api';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { cn } from '@core/primitives/styling/browser/cn';

const QUERY_KEY = ['usageLimits'];
const AGENT_LABELS: Record<AgentUsage['agent'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** Tone by how close a window is to its limit: time to hand off above 90%. */
function tone(percent: number): string {
  if (percent >= 90) return 'text-foreground-destructive';
  if (percent >= 70) return 'text-foreground-warning';
  return 'text-foreground-muted';
}

/**
 * Always-visible subscription usage (5h / weekly for Claude Code and Codex; plan and a
 * link for Cursor, whose monthly numbers only live on its dashboard), so it is obvious
 * when to hand work to another agent. Clicking it opens every account's windows (see
 * {@link AllUsagePopover}).
 */
export function UsageLimitsPanel() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const { data } = useQuery<UsageLimits>({
    queryKey: QUERY_KEY,
    queryFn: async () => (await getAgentsClient()).getUsageLimits({}),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await (await getAgentsClient()).getUsageLimits({ refresh: true });
      queryClient.setQueryData(QUERY_KEY, fresh);
    } finally {
      setRefreshing(false);
    }
  };

  const agents = data?.agents ?? [];
  if (agents.length === 0) return null;

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <div
            role="button"
            tabIndex={0}
            title="Show every account's usage"
            className="group relative mx-2 mb-1 flex cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-background-1"
          >
            {agents.map((agent) => (
              <AgentUsageRow key={agent.agent} usage={agent} />
            ))}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void refresh();
              }}
              title="Refresh usage"
              aria-label="Refresh usage"
              className={cn(
                'absolute top-1 right-1 rounded p-0.5 text-foreground-muted opacity-0 group-hover:opacity-100 hover:text-foreground',
                refreshing && 'opacity-100'
              )}
            >
              <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
            </button>
          </div>
        }
      />
      <Popover.Content align="start" side="top" className="w-96">
        <AllUsagePopover agents={agents} />
      </Popover.Content>
    </Popover.Root>
  );
}

const ACCOUNT_QUERY_KEY = ['accountUsage'];

/**
 * Every login's limit windows with their resets: each agent's usual login, then the
 * official accounts added in Settings → Providers. Accounts are probed only while this
 * is open (each probe runs the agent's CLI), then cached for a few minutes.
 */
function AllUsagePopover({ agents }: { agents: AgentUsage[] }) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const { data: accounts, isLoading } = useQuery<AgentUsage[]>({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: async () => (await getAgentsClient()).getAccountUsage({}),
    staleTime: 60_000,
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      const client = await getAgentsClient();
      const [fresh, freshAccounts] = await Promise.all([
        client.getUsageLimits({ refresh: true }),
        client.getAccountUsage({ refresh: true }),
      ]);
      queryClient.setQueryData(QUERY_KEY, fresh);
      queryClient.setQueryData(ACCOUNT_QUERY_KEY, freshAccounts);
    } finally {
      setRefreshing(false);
    }
  };

  const groups = (['claude', 'codex', 'cursor'] as const)
    .map((agent) => ({
      agent,
      rows: [
        ...agents.filter((usage) => usage.agent === agent),
        ...(accounts ?? []).filter((usage) => usage.agent === agent),
      ],
    }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Usage</span>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh usage"
          title="Refresh usage"
          className="rounded p-1 text-foreground-muted hover:bg-background-1 hover:text-foreground"
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      {groups.map((group) => (
        <div key={group.agent} className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground-passive">
            {AGENT_LABELS[group.agent]}
          </span>
          {group.rows.map((usage) => (
            <AccountUsageDetails key={usage.account?.id ?? 'default'} usage={usage} />
          ))}
        </div>
      ))}
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Spinner className="size-3" />
          <span>Checking accounts…</span>
        </div>
      ) : null}
    </div>
  );
}

function AccountUsageDetails({ usage }: { usage: AgentUsage }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-2.5 py-2">
      <div className="flex items-center gap-2 text-xs">
        {usage.account ? (
          <span translate="no" className="truncate text-foreground">
            {usage.account.name}
          </span>
        ) : (
          <span className="truncate text-foreground">Default login</span>
        )}
        {usage.plan ? (
          <span translate="no" className="ml-auto shrink-0 text-foreground-passive">
            {usage.plan}
          </span>
        ) : null}
      </div>
      {usage.detailsUrl ? (
        <button
          type="button"
          onClick={() => void openExternal(usage.detailsUrl!)}
          className="flex items-center gap-0.5 self-start text-xs text-foreground-muted hover:text-foreground"
        >
          Open the usage dashboard
          <ExternalLink className="size-3" />
        </button>
      ) : usage.unavailable || usage.windows.length === 0 ? (
        <span className="text-xs text-foreground-passive">{usage.unavailable ?? '—'}</span>
      ) : (
        usage.windows.map((window) => (
          <div key={window.label} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0">
              <UsageMeter window={window} />
            </span>
            <span className="truncate text-foreground-passive">
              {window.resets ? `resets ${window.resets}` : ''}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function AgentUsageRow({ usage }: { usage: AgentUsage }) {
  const name = AGENT_LABELS[usage.agent];
  if (usage.detailsUrl) {
    return (
      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        <span className="w-11 shrink-0">{name}</span>
        <span className="truncate">{usage.plan ?? '—'}</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void openExternal(usage.detailsUrl!);
          }}
          title="Open the usage dashboard"
          className="ml-auto flex shrink-0 items-center gap-0.5 hover:text-foreground"
        >
          Usage
          <ExternalLink className="size-3" />
        </button>
      </div>
    );
  }
  if (usage.unavailable || usage.windows.length === 0) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-foreground-passive"
        title={usage.unavailable}
      >
        <span className="w-11 shrink-0">{name}</span>
        <span className="truncate">—</span>
      </div>
    );
  }
  // The rolling 5h window and the all-models week are the ones that stop work.
  const shown = usage.windows.filter((window) => window.label === '5h' || window.label === 'Week');
  const details = usage.windows
    .map(
      (window) =>
        `${window.label}: ${window.usedPercent}%${window.resets ? ` · resets ${window.resets}` : ''}`
    )
    .join('\n');
  return (
    <div
      className="flex items-center gap-2 text-xs"
      title={`${name}${usage.plan ? ` (${usage.plan})` : ''}\n${details}`}
    >
      <span className="w-11 shrink-0 text-foreground-muted">{name}</span>
      {(shown.length ? shown : usage.windows.slice(0, 2)).map((window) => (
        <UsageMeter key={window.label} window={window} />
      ))}
    </div>
  );
}

function UsageMeter({ window }: { window: UsageWindow }) {
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  return (
    <span className={cn('flex min-w-0 flex-1 items-center gap-1', tone(percent))}>
      <span className="shrink-0 text-[10px] opacity-70">{window.label}</span>
      <span className="relative h-1 min-w-4 flex-1 overflow-hidden rounded-full bg-border">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-current"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums">{Math.round(percent)}%</span>
    </span>
  );
}
