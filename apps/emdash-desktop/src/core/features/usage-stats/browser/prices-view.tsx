import { Button, Input, Spinner } from '@emdash/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import type { ModelPriceValue } from '../api';
import { getUsageStatsClient } from '../api/browser/client';

type PriceEntry = { model: string; price: ModelPriceValue | null; manual: boolean };

const FIELDS = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];

function amount(value: number | undefined): string {
  return value === undefined
    ? '—'
    : `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function listingName(price: ModelPriceValue | null, manual: boolean): string {
  if (manual) return 'Set by hand';
  if (!price) return 'No price';
  return price.listing ? `models.dev · ${price.listing}` : 'models.dev';
}

/** One model's prices being edited: the four per-million prices as typed. */
function PriceEditor({
  model,
  price,
  onSave,
  onCancel,
}: {
  model: string;
  price: ModelPriceValue | null;
  onSave: (price: ModelPriceValue) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Record<FieldKey, string>>({
    input: String(price?.input ?? ''),
    output: String(price?.output ?? ''),
    cacheRead: price?.cacheRead === undefined ? '' : String(price.cacheRead),
    cacheWrite: price?.cacheWrite === undefined ? '' : String(price.cacheWrite),
  });
  const [saving, setSaving] = useState(false);
  const number = (text: string) => (text.trim() === '' ? undefined : Number(text));
  const valid =
    FIELDS.every(({ key }) => {
      const value = number(draft[key]);
      return value === undefined || (Number.isFinite(value) && value >= 0);
    }) &&
    number(draft.input) !== undefined &&
    number(draft.output) !== undefined;

  return (
    <div className="flex flex-col gap-2 rounded-md bg-background-1 px-3 py-2">
      <span className="text-xs text-foreground-muted">
        USD per million tokens for <span translate="no">{model}</span>. Empty cache prices fall back
        to the input price (read) and 1.25× it (write).
      </span>
      <div className="grid grid-cols-4 gap-2">
        {FIELDS.map(({ key, label }) => (
          <label key={key} className="flex flex-col gap-1 text-[11px] text-foreground-muted">
            {label}
            <Input
              type="number"
              min={0}
              step={0.01}
              value={draft[key]}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [key]: event.target.value }))
              }
            />
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={async () => {
            setSaving(true);
            try {
              const cacheRead = number(draft.cacheRead);
              const cacheWrite = number(draft.cacheWrite);
              await onSave({
                input: number(draft.input)!,
                output: number(draft.output)!,
                ...(cacheRead !== undefined && { cacheRead }),
                ...(cacheWrite !== undefined && { cacheWrite }),
                // A long-context price stays models.dev's only while the price is theirs.
              });
            } finally {
              setSaving(false);
            }
          }}
        >
          Save price
        </Button>
      </div>
    </div>
  );
}

/** Every listing of a model on models.dev, to take the one actually paid. */
function Listings({
  model,
  onUse,
}: {
  model: string;
  onUse: (price: ModelPriceValue) => Promise<void>;
}) {
  const [listings, setListings] = useState<ModelPriceValue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = await getUsageStatsClient();
        const found = await client.modelListings({ model }, { timeoutMs: 60_000 });
        if (!cancelled) setListings(found);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [model]);

  if (error) return <p className="text-destructive px-3 py-2 text-xs">{error}</p>;
  if (!listings) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-foreground-muted">
        <Spinner size="sm" /> Fetching models.dev…
      </div>
    );
  }
  if (listings.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-foreground-muted">models.dev lists no price for it.</p>
    );
  }
  return (
    <div className="flex max-h-56 flex-col overflow-y-auto rounded-md bg-background-1">
      {listings.map((listing) => (
        <div
          key={listing.listing}
          className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs last:border-0"
        >
          <span className="min-w-0 flex-1 truncate text-foreground" translate="no">
            {listing.listing}
          </span>
          <span className="text-foreground-muted tabular-nums">
            {amount(listing.input)} / {amount(listing.output)} / {amount(listing.cacheRead)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void onUse(listing)}>
            Use this
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * The prices each model used in the range is counted at: models.dev's (whose listing),
 * or one set by hand. A price can be typed in, taken from another listing, or reset.
 */
export function PricesView({ models, onChanged }: { models: string[]; onChanged: () => void }) {
  const [entries, setEntries] = useState<PriceEntry[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const client = await getUsageStatsClient();
      const result = await client.prices({ models });
      setEntries(result.models);
      setFetchedAt(result.fetchedAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [models]);

  useEffect(() => {
    void load();
  }, [load]);

  const setPrice = async (model: string, price: ModelPriceValue | null) => {
    const client = await getUsageStatsClient();
    await client.setModelPrice({ model, price });
    setEditing(null);
    setBrowsing(null);
    await load();
    onChanged();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted">
        <span>
          {fetchedAt
            ? `USD per million tokens. From models.dev, updated ${new Date(fetchedAt).toLocaleString()}.`
            : 'USD per million tokens. From models.dev.'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              const client = await getUsageStatsClient();
              await client.refreshPrices(undefined, { timeoutMs: 120_000 });
              await load();
              onChanged();
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh all'}
        </Button>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {!entries ? (
        <div className="flex items-center gap-2 py-6 text-sm text-foreground-muted">
          <Spinner size="sm" /> Loading prices…
        </div>
      ) : entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-foreground-muted">
          No models used in this range.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {entries.map((entry) => (
            <div key={entry.model} className="flex flex-col gap-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-40 flex-1 truncate text-sm text-foreground" translate="no">
                  {entry.model}
                </span>
                <span className="text-xs text-foreground-muted tabular-nums">
                  in {amount(entry.price?.input)} · out {amount(entry.price?.output)} · cache{' '}
                  {amount(entry.price?.cacheRead)} / {amount(entry.price?.cacheWrite)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`flex-1 truncate text-[11px] ${entry.manual ? 'text-foreground-info' : 'text-foreground-muted'}`}
                  translate={entry.manual ? undefined : 'no'}
                >
                  {listingName(entry.price, entry.manual)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(editing === entry.model ? null : entry.model)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBrowsing(browsing === entry.model ? null : entry.model)}
                >
                  Other listings
                </Button>
                {entry.manual ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void setPrice(entry.model, null)}
                  >
                    Reset
                  </Button>
                ) : null}
              </div>
              {editing === entry.model ? (
                <PriceEditor
                  model={entry.model}
                  price={entry.price}
                  onSave={(price) => setPrice(entry.model, price)}
                  onCancel={() => setEditing(null)}
                />
              ) : null}
              {browsing === entry.model ? (
                <Listings model={entry.model} onUse={(price) => setPrice(entry.model, price)} />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
