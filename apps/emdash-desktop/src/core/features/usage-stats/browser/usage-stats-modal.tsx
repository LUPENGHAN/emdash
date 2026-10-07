import {
  Button,
  Dialog,
  Input,
  Select,
  Spinner,
  Switch,
  ToggleGroup,
} from '@emdash/ui/react/primitives';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { defineModal } from '@core/primitives/modals/react';
import {
  agentDisplayName,
  type SourcePricing,
  type UsageBilling,
  type UsageCurrency,
  type UsagePricing,
  type UsageReport,
  type UsageRow,
  type UsageSource,
} from '../api';
import { getUsageStatsClient } from '../api/browser/client';

/** A report reads every computer's session history on first use: give it time. */
const REPORT_TIMEOUT_MS = 180_000;

const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const GROUPS = [
  { id: 'source', label: 'Source' },
  { id: 'model', label: 'Model' },
  { id: 'agent', label: 'Agent' },
  { id: 'project', label: 'Project' },
  { id: 'machine', label: 'Computer' },
] as const;
type GroupId = (typeof GROUPS)[number]['id'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local days of a range ending today, oldest first. */
function rangeDays(days: number): string[] {
  const today = new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - index));
    return dayOf(date);
  });
}

type Totals = {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** List-price value of every call (what the API would charge). */
  listUsd: number;
  /** Charged per call, by currency. */
  charged: Record<UsageCurrency, number>;
  /** List-price value of the calls a subscription covered. */
  subscriptionUsd: number;
};

const emptyTotals = (): Totals => ({
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  listUsd: 0,
  charged: { USD: 0, CNY: 0 },
  subscriptionUsd: 0,
});

function add(totals: Totals, row: UsageRow): void {
  totals.requests += row.requests;
  totals.input += row.input;
  totals.output += row.output;
  totals.cacheRead += row.cacheRead;
  totals.cacheWrite += row.cacheWrite;
  totals.listUsd += row.listUsd ?? 0;
  if (row.amount !== null) totals.charged[row.currency] += row.amount;
  if (row.billing === 'subscription') totals.subscriptionUsd += row.listUsd ?? 0;
}

function groupKey(row: UsageRow, group: GroupId): string {
  if (group === 'source') return row.sourceName;
  if (group === 'agent') return agentDisplayName(row.agent);
  return row[group];
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

function money(value: number, currency: UsageCurrency): string {
  const symbol = currency === 'USD' ? '$' : '¥';
  return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Charged amounts, each in its currency, with a single total when both appear. */
function chargedText(charged: Totals['charged'], usdToCny: number): string {
  const parts = (['USD', 'CNY'] as const)
    .filter((currency) => charged[currency] > 0)
    .map((currency) => money(charged[currency], currency));
  if (parts.length === 0) return money(0, 'USD');
  if (parts.length === 1) return parts[0]!;
  return `${parts.join(' + ')} ≈ ${money(charged.CNY + charged.USD * usdToCny, 'CNY')}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-3 py-2">
      <span className="text-xs text-foreground-muted">{label}</span>
      <span className="truncate text-base font-medium text-foreground tabular-nums">{value}</span>
      {hint ? <span className="text-[11px] text-foreground-muted">{hint}</span> : null}
    </div>
  );
}

/** One bar a day: charged per call (converted to USD) over the subscriptions' list value. */
function DailyBars({
  days,
  rows,
  usdToCny,
}: {
  days: string[];
  rows: UsageRow[];
  usdToCny: number;
}) {
  const perDay = useMemo(() => {
    const map = new Map(days.map((day) => [day, { charged: 0, subscription: 0 }]));
    for (const row of rows) {
      const entry = map.get(row.day);
      if (!entry) continue;
      if (row.amount !== null) {
        entry.charged += row.currency === 'USD' ? row.amount : row.amount / usdToCny;
      }
      if (row.billing === 'subscription') entry.subscription += row.listUsd ?? 0;
    }
    return days.map((day) => ({ day, ...map.get(day)! }));
  }, [days, rows, usdToCny]);
  const max = Math.max(...perDay.map((entry) => entry.charged + entry.subscription), 0.01);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-28 items-end gap-px">
        {perDay.map((entry) => (
          <div
            key={entry.day}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${entry.day}\nCharged per call: ${money(entry.charged, 'USD')}\nSubscriptions at list prices: ${money(entry.subscription, 'USD')}`}
          >
            <div
              className="w-full rounded-t-[2px] bg-foreground-muted/30"
              style={{ height: `${(entry.subscription / max) * 100}%` }}
            />
            <div
              className="w-full bg-foreground-info"
              style={{ height: `${(entry.charged / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-foreground-muted">
        <span>{days[0]}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-sm bg-foreground-info" /> Charged per call
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2 rounded-sm bg-foreground-muted/30" /> Subscriptions
            at list prices
          </span>
        </span>
        <span>{days.at(-1)}</span>
      </div>
    </div>
  );
}

function PricingEditor({
  pricing,
  sources,
  onSave,
}: {
  pricing: UsagePricing;
  sources: UsageSource[];
  onSave: (next: UsagePricing) => Promise<void>;
}) {
  const [draft, setDraft] = useState(pricing);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(pricing), [pricing]);
  const update = (key: string, patch: SourcePricing) =>
    setDraft((current) => ({
      ...current,
      sources: { ...current.sources, [key]: { ...current.sources[key], ...patch } },
    }));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground-muted">
        How each source bills, on this computer. Per call: the list price × the rate, in its
        currency (a reseller selling $1 of list price for ¥0.6 is 0.6 CNY). Subscription: a flat
        fee, so its calls cost nothing more.
      </p>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {sources.map((source) => {
          const settings = draft.sources[source.key] ?? {};
          const billing = settings.billing ?? source.defaultBilling;
          return (
            <div
              key={source.key}
              className="grid grid-cols-[minmax(0,1fr)_8rem_5rem_5.5rem] items-center gap-2 px-3 py-2"
            >
              <span className="truncate text-sm text-foreground">{source.name}</span>
              <Select.Root
                value={billing}
                onValueChange={(next) => update(source.key, { billing: next as UsageBilling })}
              >
                <Select.Trigger appearance="input" className="w-full">
                  <Select.Value>{billing === 'usage' ? 'Per call' : 'Subscription'}</Select.Value>
                </Select.Trigger>
                <Select.Content align="start" width="trigger">
                  <Select.Item value="usage">Per call</Select.Item>
                  <Select.Item value="subscription">Subscription</Select.Item>
                </Select.Content>
              </Select.Root>
              {billing === 'usage' ? (
                <>
                  <Input
                    className="w-full"
                    type="number"
                    min={0}
                    step={0.05}
                    aria-label="Rate"
                    value={settings.multiplier ?? 1}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (value > 0) update(source.key, { multiplier: value });
                    }}
                  />
                  <Select.Root
                    value={settings.currency ?? 'USD'}
                    onValueChange={(next) =>
                      update(source.key, { currency: next as UsageCurrency })
                    }
                  >
                    <Select.Trigger appearance="input" className="w-full">
                      <Select.Value>{settings.currency ?? 'USD'}</Select.Value>
                    </Select.Trigger>
                    <Select.Content align="start" width="trigger">
                      <Select.Item value="USD">USD</Select.Item>
                      <Select.Item value="CNY">CNY</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <label className="flex shrink-0 items-center gap-2 text-xs whitespace-nowrap text-foreground-muted">
          1 USD =
          <Input
            className="w-20"
            type="number"
            min={0}
            step={0.01}
            value={draft.usdToCny}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value > 0) setDraft((current) => ({ ...current, usdToCny: value }));
            }}
          />
          CNY
        </label>
        <Button
          size="sm"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(draft);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save pricing
        </Button>
      </div>
    </div>
  );
}

function UsageStatsModal() {
  const [range, setRange] = useState<RangeId>('30d');
  const [group, setGroup] = useState<GroupId>('source');
  const [allMachines, setAllMachines] = useState(true);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pricing, setPricing] = useState<{ pricing: UsagePricing; sources: UsageSource[] } | null>(
    null
  );
  const [showPricing, setShowPricing] = useState(false);

  const days = useMemo(() => rangeDays(RANGES.find((r) => r.id === range)!.days), [range]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = await getUsageStatsClient();
      const [next, nextPricing] = await Promise.all([
        client.report(
          { from: days[0]!, to: days.at(-1)!, allMachines },
          { timeoutMs: REPORT_TIMEOUT_MS }
        ),
        client.pricing(undefined, { timeoutMs: REPORT_TIMEOUT_MS }),
      ]);
      setReport(next);
      setPricing(nextPricing);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [days, allMachines]);

  useEffect(() => {
    void load();
  }, [load]);

  const usdToCny = pricing?.pricing.usdToCny ?? 7.1;
  const rows = report?.rows ?? [];
  const totals = useMemo(() => {
    const sum = emptyTotals();
    for (const row of rows) add(sum, row);
    return sum;
  }, [rows]);
  const grouped = useMemo(() => {
    const map = new Map<string, Totals>();
    for (const row of rows) {
      const key = groupKey(row, group);
      let entry = map.get(key);
      if (!entry) {
        entry = emptyTotals();
        map.set(key, entry);
      }
      add(entry, row);
    }
    return [...map.entries()].sort((a, b) => b[1].listUsd - a[1].listUsd);
  }, [rows, group]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Usage statistics</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup.Root
              value={[range]}
              onValueChange={([next]) => {
                if (next) setRange(next as RangeId);
              }}
            >
              {RANGES.map((option) => (
                <ToggleGroup.Item key={option.id} value={option.id}>
                  {option.label}
                </ToggleGroup.Item>
              ))}
            </ToggleGroup.Root>
            <label className="flex items-center gap-2 text-xs text-foreground-muted">
              <Switch checked={allMachines} onCheckedChange={setAllMachines} />
              All computers
            </label>
          </div>

          {report ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-muted">
              {report.machines.map((machine) => (
                <span key={machine.name}>
                  {machine.error ? '⚠️' : '✓'} <span translate="no">{machine.name}</span>
                  {machine.local ? <span> (this computer)</span> : null}
                  {machine.error ? <span> — {machine.error}</span> : null}
                </span>
              ))}
            </div>
          ) : null}

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          {loading && !report ? (
            <div className="flex items-center gap-2 py-8 text-sm text-foreground-muted">
              <Spinner size="sm" /> Reading the agents' session records… the first time takes a
              little while.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Calls" value={whole.format(totals.requests)} />
                <Stat
                  label="Tokens"
                  value={compact.format(
                    totals.input + totals.output + totals.cacheRead + totals.cacheWrite
                  )}
                  hint={`in ${compact.format(totals.input)} · out ${compact.format(totals.output)} · cache ${compact.format(totals.cacheRead + totals.cacheWrite)}`}
                />
                <Stat
                  label="Charged per call"
                  value={chargedText(totals.charged, usdToCny)}
                  hint="Gateways and API keys, at your rates"
                />
                <Stat
                  label="Subscriptions at list prices"
                  value={money(totals.subscriptionUsd, 'USD')}
                  hint="What the same calls would cost on the API"
                />
              </div>

              <DailyBars days={days} rows={rows} usdToCny={usdToCny} />

              <div className="flex flex-col gap-2">
                <ToggleGroup.Root
                  value={[group]}
                  onValueChange={([next]) => {
                    if (next) setGroup(next as GroupId);
                  }}
                >
                  {GROUPS.map((option) => (
                    <ToggleGroup.Item key={option.id} value={option.id}>
                      {option.label}
                    </ToggleGroup.Item>
                  ))}
                </ToggleGroup.Root>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-xs whitespace-nowrap tabular-nums">
                    <thead className="text-foreground-muted">
                      <tr className="border-b border-border">
                        <th className="px-2 py-1.5 text-left font-normal">
                          {GROUPS.find((option) => option.id === group)!.label}
                        </th>
                        <th className="px-2 py-1.5 text-right font-normal">Calls</th>
                        <th className="px-2 py-1.5 text-right font-normal">Input</th>
                        <th className="px-2 py-1.5 text-right font-normal">Output</th>
                        <th className="px-2 py-1.5 text-right font-normal">Cache</th>
                        <th className="px-2 py-1.5 text-right font-normal">Charged</th>
                        <th className="px-2 py-1.5 text-right font-normal">List price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped.map(([name, entry]) => (
                        <tr key={name} className="border-b border-border last:border-0">
                          <td
                            className="max-w-56 truncate px-2 py-1.5 text-foreground"
                            // Source names read "Codex · own configuration": translated.
                            translate={group === 'source' ? undefined : 'no'}
                          >
                            {name}
                          </td>
                          <td className="px-2 py-1.5 text-right">{whole.format(entry.requests)}</td>
                          <td className="px-2 py-1.5 text-right">{compact.format(entry.input)}</td>
                          <td className="px-2 py-1.5 text-right">{compact.format(entry.output)}</td>
                          <td className="px-2 py-1.5 text-right">
                            {compact.format(entry.cacheRead + entry.cacheWrite)}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {entry.charged.USD + entry.charged.CNY > 0
                              ? chargedText(entry.charged, usdToCny)
                              : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right text-foreground-muted">
                            {money(entry.listUsd, 'USD')}
                          </td>
                        </tr>
                      ))}
                      {grouped.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-4 text-center text-foreground-muted">
                            No calls in this range.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-[11px] text-foreground-muted">
                From each agent's own session records (Claude Code, Codex, Pi, Oh My Pi), including
                sessions started outside Emdash. Cursor keeps no token records, so it is not counted
                here.
                {report?.unpricedModels.length ? (
                  <>
                    {' '}
                    No list price for:{' '}
                    <span translate="no">{report.unpricedModels.join(', ')}</span>.
                  </>
                ) : null}
              </p>

              <div className="flex flex-col gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setShowPricing((shown) => !shown)}
                >
                  {showPricing ? 'Hide pricing' : 'Pricing…'}
                </Button>
                {showPricing && pricing ? (
                  <PricingEditor
                    pricing={pricing.pricing}
                    sources={pricing.sources}
                    onSave={async (next) => {
                      const client = await getUsageStatsClient();
                      await client.setPricing(next);
                      await load();
                    }}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      </Dialog.Body>
    </>
  );
}

export const usageStatsModal = defineModal()({
  id: 'usageStatsModal',
  component: UsageStatsModal,
  size: 'lg',
});
