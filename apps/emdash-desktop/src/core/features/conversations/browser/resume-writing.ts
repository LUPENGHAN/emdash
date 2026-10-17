import type { ResumeJob } from '@core/features/conversations/contributions/resume-settings';

export type ResumeUsageWindow = {
  label: string;
  usedPercent: number;
};

/** One login's subscription usage. `accountId` null is the agent's usual login. */
export type ResumeUsage = {
  agent: string;
  accountId: string | null;
  windows: ResumeUsageWindow[];
};

export type ResumeDecision =
  | { type: 'none' }
  | { type: 'remember'; patch: Partial<ResumeJob> }
  | {
      type: 'send';
      reason: 'clock' | 'window-reset';
      patch: Partial<ResumeJob>;
    }
  | {
      type: 'switch';
      accountId: string | null;
      patch: Partial<ResumeJob>;
    };

const CLOCK_WINDOW_MS = 2 * 60 * 1000;

export function decideResume(input: {
  now: Date;
  job: ResumeJob;
  providerId: string | null;
  modelSource?: string | null;
  accounts: readonly ResumeUsage[];
}): ResumeDecision {
  const { job } = input;
  if (!job.enabled || !job.projectId || !job.taskId || !job.conversationId) {
    return { type: 'none' };
  }

  const quota = quotaDecision(input);
  if (quota.type !== 'none') return quota;

  const clock = clockDecision(input.now, job);
  if (clock) return clock;

  if (job.onWindowReset && input.providerId) {
    const current = currentUsage(input);
    if (current) return windowDecision(job, current);
  }

  return { type: 'none' };
}

function clockDecision(now: Date, job: ResumeJob): ResumeDecision | null {
  const match = /^(\d{2}):(\d{2})$/.exec(job.clockTime.trim());
  if (!match) return null;
  const day = localDay(now);
  if (job.clockDay === day) return null;
  const target = new Date(now);
  target.setHours(Number(match[1]), Number(match[2]), 0, 0);
  const delta = now.getTime() - target.getTime();
  if (delta < 0 || delta >= CLOCK_WINDOW_MS) return null;
  return { type: 'send', reason: 'clock', patch: { clockDay: day } };
}

/**
 * A window counts as reset when its usage drops by at least this many points. Reset times
 * are display text that changes on its own (and disappears once a window expires), so
 * only the percentages are compared.
 */
const RESET_DROP_POINTS = 15;

/** `account#label=percent;label=percent`, so a reading from another login never compares. */
function usageReading(usage: ResumeUsage): string {
  const windows = usage.windows
    .map((window) => `${window.label}=${Math.round(window.usedPercent)}`)
    .join(';');
  return `${usage.accountId ?? 'default'}#${windows}`;
}

function parseReading(reading: string | null): { account: string; percents: Map<string, number> } {
  const [account = '', windows = ''] = (reading ?? '').split('#');
  const percents = new Map<string, number>();
  for (const entry of windows.split(';')) {
    const at = entry.lastIndexOf('=');
    const value = Number(entry.slice(at + 1));
    if (at > 0 && Number.isFinite(value)) percents.set(entry.slice(0, at), value);
  }
  return { account, percents };
}

function windowDecision(job: ResumeJob, usage: ResumeUsage): ResumeDecision {
  if (usage.windows.length === 0) return { type: 'none' };
  const reading = usageReading(usage);
  if (reading === job.usagePercents) return { type: 'none' };
  const previous = parseReading(job.usagePercents);
  const sameAccount = previous.account === (usage.accountId ?? 'default');
  const dropped =
    sameAccount &&
    usage.windows.some((window) => {
      const before = previous.percents.get(window.label);
      return before !== undefined && window.usedPercent + RESET_DROP_POINTS <= before;
    });
  return dropped
    ? { type: 'send', reason: 'window-reset', patch: { usagePercents: reading } }
    : { type: 'remember', patch: { usagePercents: reading } };
}

function quotaDecision(input: {
  job: ResumeJob;
  providerId: string | null;
  modelSource?: string | null;
  accounts: readonly ResumeUsage[];
}): ResumeDecision {
  const { job } = input;
  if (job.quotaPercent == null || !input.providerId) return { type: 'none' };
  const current = currentUsage(input);
  if (!current || current.windows.length === 0) return { type: 'none' };
  const hottest = Math.max(...current.windows.map((window) => window.usedPercent));
  if (hottest < job.quotaPercent) {
    // Back under the limit (its window reset): the next time it fills may switch again.
    return job.quotaKey ? { type: 'remember', patch: { quotaKey: null } } : { type: 'none' };
  }
  const from = current.accountId ?? 'default';
  const next = input.accounts
    .filter(
      (account) => account.agent === input.providerId && account.accountId !== current.accountId
    )
    .map((account) => ({
      account,
      hottest: account.windows.length
        ? Math.max(...account.windows.map((window) => window.usedPercent))
        : 0,
    }))
    .filter((candidate) => candidate.hottest < job.quotaPercent!)
    .sort((left, right) => left.hottest - right.hottest)[0];
  const target = next ? (next.account.accountId ?? 'default') : 'stuck';
  const key = `${from}->${target}`;
  const handled =
    job.quotaKey === key ||
    (job.quotaKey?.startsWith(`${from}->`) && job.quotaKey !== `${from}->stuck`);
  if (handled) return { type: 'none' };
  if (!next) return { type: 'remember', patch: { quotaKey: key } };
  return {
    type: 'switch',
    accountId: next.account.accountId,
    patch: { quotaKey: key, usagePercents: null },
  };
}

function currentUsage(input: {
  providerId: string | null;
  modelSource?: string | null;
  accounts: readonly ResumeUsage[];
}): ResumeUsage | null {
  if (!input.providerId) return null;
  const mine = input.accounts.filter((account) => account.agent === input.providerId);
  if (typeof input.modelSource === 'string') {
    return mine.find((account) => account.accountId === input.modelSource) ?? null;
  }
  return mine.find((account) => account.accountId === null) ?? null;
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
