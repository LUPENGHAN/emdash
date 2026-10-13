import { toast } from '@emdash/ui/react/primitives';
import { useEffect, useRef } from 'react';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { sendToConversation } from '@core/features/conversations/api/browser/send-to-conversation';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  DEFAULT_RESUME_WRITING_SETTINGS,
  type ResumeWritingSettings,
} from '@core/features/conversations/contributions/resume-settings';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import type { Conversation } from '@core/primitives/conversations/api';
import { decideResume, type ResumeUsage } from './resume-writing';

const USAGE_TTL_MS = 5 * 60 * 1000;
const TICK_MS = 20_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60 * 1000;

let ticking = false;
let usageAt = 0;
let usageCache: ResumeUsage[] = [];
let failures = 0;
let retryAt = 0;

/** While the app is open, sends the configured continue message when its trigger is due. */
export function ResumeWritingWatcher() {
  const { value, updateAsync } = useAppSettingsKey('resumeWriting');
  const settingsRef = useRef(value ?? DEFAULT_RESUME_WRITING_SETTINGS);
  const updateRef = useRef(updateAsync);
  settingsRef.current = value ?? DEFAULT_RESUME_WRITING_SETTINGS;
  updateRef.current = updateAsync;
  const enabled = settingsRef.current.enabled;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      void runResumeTick(settingsRef.current, (patch) => updateRef.current(patch));
    };
    const id = window.setInterval(tick, TICK_MS);
    tick();
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  return null;
}

async function runResumeTick(
  settings: ResumeWritingSettings,
  update: (patch: Partial<ResumeWritingSettings>) => Promise<void>
): Promise<void> {
  if (ticking || !settings.enabled || Date.now() < retryAt) return;
  ticking = true;
  try {
    const conversation = await loadConversation(settings);
    const needsUsage = settings.quotaPercent != null || settings.onWindowReset;
    const accounts = needsUsage ? await loadUsage() : [];
    const decision = decideResume({
      now: new Date(),
      settings,
      providerId: conversation?.providerId ?? null,
      modelSource: conversation?.modelSource,
      accounts,
    });
    if (decision.type === 'none') return;
    if (decision.type === 'remember') {
      await update(decision.patch);
      return;
    }
    if (settings.confirm) {
      const confirmed = await openModal('confirmActionModal', {
        title:
          decision.type === 'switch'
            ? 'Continue on another account?'
            : 'Continue this conversation?',
        description:
          decision.type === 'switch'
            ? 'The current official account is past the limit you set. Emdash will open a new conversation on the next account and send the handoff.'
            : `Emdash will send “${settings.text || '继续'}” to this conversation.`,
        confirmLabel: 'Continue',
      });
      if (!confirmed.success) {
        await update(decision.patch);
        return;
      }
    }
    if (!conversation) throw new Error('That conversation is gone');
    if (decision.type === 'send') {
      await deliver(settings, conversation);
      await update(decision.patch);
    } else {
      // Recorded first: a failure after the new conversation exists must not open another.
      await update(decision.patch);
      const createdId = await handoff(settings, conversation, decision.accountId);
      await update({ conversationId: createdId });
    }
    failures = 0;
    retryAt = 0;
  } catch (error) {
    failures += 1;
    retryAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    ticking = false;
  }
}

async function loadConversation(settings: ResumeWritingSettings): Promise<Conversation | null> {
  if (!settings.projectId || !settings.taskId || !settings.conversationId) return null;
  const conversations = await (
    await getConversationsClient()
  ).getConversationsForTask({
    projectId: settings.projectId,
    taskId: settings.taskId,
  });
  return conversations.find((item) => item.id === settings.conversationId) ?? null;
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

async function deliver(settings: ResumeWritingSettings, conversation: Conversation): Promise<void> {
  const text = settings.text.trim() || '继续';
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
  settings: ResumeWritingSettings,
  conversation: Conversation,
  accountId: string | null
): Promise<string> {
  const client = await getConversationsClient();
  const prepared = await client.prepareHandoff({
    conversationId: conversation.id,
    note: settings.text.trim() || '继续',
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
