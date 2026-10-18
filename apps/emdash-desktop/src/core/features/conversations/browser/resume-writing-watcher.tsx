import { toast } from '@emdash/ui/react/primitives';
import { useEffect, useRef, useState } from 'react';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { sendToConversation } from '@core/features/conversations/api/browser/send-to-conversation';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  DEFAULT_RESUME_WRITING_SETTINGS,
  type ResumeJob,
} from '@core/features/conversations/contributions/resume-settings';
import { getRemoteClientClient } from '@core/features/remote-access/api/browser/remote-client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import type { Conversation } from '@core/primitives/conversations/api';
import { patchResumeJob } from './resume-jobs-store';
import { decideResume, type ResumeDecision, type ResumeUsage } from './resume-writing';

const USAGE_TTL_MS = 5 * 60 * 1000;
const TICK_MS = 20_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60 * 1000;

/** One entry per job id: a slow or failing job backs off alone. */
const running = new Set<string>();
const failures = new Map<string, number>();
const retryAt = new Map<string, number>();
let usageAt = 0;
let usageCache: ResumeUsage[] = [];

/**
 * While the app is open, sends each configured continue message when its trigger is
 * due. One window must own this: a window driving another computer would double-send
 * alongside that computer's own window (a remote-browser tab never mounts this
 * watcher; see App.tsx).
 */
export function ResumeWritingWatcher() {
  const { value } = useAppSettingsKey('resumeWriting');
  const jobsRef = useRef(value?.jobs ?? DEFAULT_RESUME_WRITING_SETTINGS.jobs);
  jobsRef.current = value?.jobs ?? DEFAULT_RESUME_WRITING_SETTINGS.jobs;
  const anyEnabled = jobsRef.current.some((job) => job.enabled);
  // Switching computers reloads the window, so a mount-time check is enough.
  const [drivesAnotherComputer, setDrivesAnotherComputer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getRemoteClientClient()
      .then((client) => client.state())
      .then((state) => {
        if (!cancelled) setDrivesAnotherComputer(state.activeServerId !== null);
      })
      .catch(() => {
        // Unreachable remote-access state never blocks local jobs.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = !drivesAnotherComputer && anyEnabled;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      void runResumeTick(jobsRef.current);
    };
    const id = window.setInterval(tick, TICK_MS);
    tick();
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [active]);

  return null;
}

async function runResumeTick(jobs: readonly ResumeJob[]): Promise<void> {
  // Sequential: two dialogs at once would be unreadable, and usage stays cached per tick.
  for (const job of jobs) {
    if (job.enabled) await runResumeJob(job);
  }
}

async function runResumeJob(job: ResumeJob): Promise<void> {
  if (running.has(job.id) || Date.now() < (retryAt.get(job.id) ?? 0)) return;
  running.add(job.id);
  try {
    const conversation = await loadConversation(job);
    const needsUsage = job.quotaPercent != null || job.onWindowReset;
    const accounts = needsUsage ? await loadUsage() : [];
    const decision = decideResume({
      now: new Date(),
      job,
      providerId: conversation?.providerId ?? null,
      modelSource: conversation?.modelSource,
      accounts,
    });
    if (decision.type === 'none') return;
    if (decision.type === 'remember') {
      await patchResumeJob(job.id, decision.patch);
      return;
    }
    if (job.confirm) {
      const confirmed = await openModal('confirmActionModal', {
        title: confirmTitle(decision, conversation),
        description:
          decision.type === 'switch'
            ? 'The current official account is past the limit you set. Emdash will open a new conversation on the next account and send the handoff.'
            : `Emdash will send “${job.text || '继续'}” to this conversation.`,
        confirmLabel: 'Continue',
      });
      if (!confirmed.success) {
        await patchResumeJob(job.id, decision.patch);
        return;
      }
    }
    if (!conversation) throw new Error('That conversation is gone');
    if (decision.type === 'send') {
      await deliver(job, conversation);
      await patchResumeJob(job.id, decision.patch);
    } else {
      // Recorded first: a failure after the new conversation exists must not open another.
      await patchResumeJob(job.id, decision.patch);
      const createdId = await handoff(job, conversation, decision.accountId);
      await patchResumeJob(job.id, { conversationId: createdId });
    }
    failures.set(job.id, 0);
    retryAt.set(job.id, 0);
  } catch (error) {
    const count = (failures.get(job.id) ?? 0) + 1;
    failures.set(job.id, count);
    retryAt.set(job.id, Date.now() + Math.min(RETRY_BASE_MS * 2 ** (count - 1), RETRY_MAX_MS));
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    running.delete(job.id);
  }
}

/** Names the conversation so, with several jobs, the user knows which one is asking. */
function confirmTitle(
  decision: Extract<ResumeDecision, { type: 'send' | 'switch' }>,
  conversation: Conversation | null
): string {
  const title = conversation?.title;
  if (decision.type === 'switch') {
    return title ? `Continue “${title}” on another account?` : 'Continue on another account?';
  }
  return title ? `Continue “${title}”?` : 'Continue this conversation?';
}

async function loadConversation(job: ResumeJob): Promise<Conversation | null> {
  if (!job.projectId || !job.taskId || !job.conversationId) return null;
  const conversations = await (
    await getConversationsClient()
  ).getConversationsForTask({
    projectId: job.projectId,
    taskId: job.taskId,
  });
  return conversations.find((item) => item.id === job.conversationId) ?? null;
}

async function loadUsage(): Promise<ResumeUsage[]> {
  if (Date.now() - usageAt < USAGE_TTL_MS) return usageCache;
  const client = await getAgentsClient();
  const [accounts, limits] = await Promise.all([
    client.getAccountUsage({}),
    client.getUsageLimits({}),
  ]);
  usageCache = [
    ...accounts.map((account) => ({
      agent: account.agent,
      accountId: account.account?.id ?? null,
      windows: account.windows,
    })),
    ...limits.agents.map((account) => ({
      agent: account.agent,
      accountId: null as string | null,
      windows: account.windows,
    })),
  ];
  usageAt = Date.now();
  return usageCache;
}

async function deliver(job: ResumeJob, conversation: Conversation): Promise<void> {
  const text = job.text.trim() || '继续';
  if (conversation.type === 'pty') {
    const manager = conversationRegistry.get(conversation.taskId);
    if (!manager) throw new Error('Open this task to continue a terminal conversation');
    await sendToConversation(manager, conversation, text);
    return;
  }
  const client = await getConversationsClient();
  const send = () =>
    client.acp.sendPrompt(
      {
        conversationId: conversation.id,
        promptId: crypto.randomUUID(),
        prompt: { text },
        placement: 'auto',
      },
      { timeoutMs: 0 }
    );
  const sent = await send();
  if (sent.success) return;
  // Only a chat whose agent is not running is started and sent again; any other failure
  // may have delivered the prompt already.
  if (errorType(sent.error) !== 'session_not_found') {
    throw new Error('The chat did not accept the message');
  }
  await client.hydrateConversation({
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    conversationId: conversation.id,
  });
  const again = await send();
  if (!again.success) throw new Error('The chat did not accept the message');
}

function errorType(error: unknown): string | null {
  return error && typeof error === 'object' && 'type' in error && typeof error.type === 'string'
    ? error.type
    : null;
}

async function handoff(
  job: ResumeJob,
  conversation: Conversation,
  accountId: string | null
): Promise<string> {
  const client = await getConversationsClient();
  const prepared = await client.prepareHandoff({
    conversationId: conversation.id,
    note: job.text.trim() || '继续',
  });
  const id = crypto.randomUUID();
  const type = conversation.type ?? 'acp';
  const created = await client.createConversation({
    id,
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    provider: conversation.providerId,
    title: `${conversation.title} · continue`.slice(0, 100),
    type,
    modelSource: accountId,
    ...(type === 'acp'
      ? { initialQueue: [{ text: prepared.prompt }] }
      : { initialPrompt: prepared.prompt }),
  });
  if (!created.success) throw new Error('Could not open the next conversation');
  const hydrated = await client.hydrateConversation({
    projectId: conversation.projectId,
    taskId: conversation.taskId,
    conversationId: id,
  });
  if (!hydrated.success) {
    toast.success('Opened the next conversation. It sends when you open the task.');
  }
  return id;
}
