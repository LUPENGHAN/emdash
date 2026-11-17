import { createHash } from 'node:crypto';
import { stableStringify } from '@emdash/shared/util';
import { sourceOverrideOf } from '@core/features/model-providers/api';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import type { DelegationSelectionSnapshot } from '../api/selection-snapshot';
import type { CreateDelegatedTask } from './task-delegation-service';

type Conversation = NonNullable<CreateTaskParams['taskConfig']['initialConversation']>;
type Sources = DelegationSelectionSnapshot['sources'];

/** Projects only launch selections; prompts, environment and credentials never enter this receipt. */
function valuesOf(conversation: Conversation): DelegationSelectionSnapshot['values'] {
  const nativeModel =
    typeof conversation.options?.model === 'string' ? conversation.options.model : null;
  return {
    agent: conversation.provider,
    transport: conversation.type ?? 'pty',
    modelSource: conversation.modelSource ?? null,
    model: conversation.modelSource
      ? (conversation.sourceModel ?? null)
      : ((conversation.type === 'acp' ? (nativeModel ?? conversation.model) : conversation.model) ??
        null),
    supplierId: conversation.supplierId ?? null,
    effort: sourceOverrideOf(conversation)?.effort ?? null,
  };
}

function fingerprint(snapshot: Omit<DelegationSelectionSnapshot, 'fingerprint'>) {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

export function freezeDelegationSelection(
  conversation: Conversation,
  request: CreateDelegatedTask,
  defaults: Partial<CreateDelegatedTask> | undefined,
  saved: ProviderCustomConfig | undefined
): DelegationSelectionSnapshot {
  const selected = (...keys: (keyof CreateDelegatedTask)[]): Sources['agent'] | undefined =>
    keys.some((key) => request[key] !== undefined)
      ? 'request'
      : keys.some((key) => defaults?.[key] !== undefined)
        ? 'main-default'
        : undefined;
  const values = valuesOf(conversation);
  const snapshot: Omit<DelegationSelectionSnapshot, 'fingerprint'> = {
    version: '1',
    values,
    sources: {
      agent: selected('providerId') ?? 'caller',
      transport: selected('ui') ?? 'adapter-default',
      modelSource:
        selected('connection', 'supplierId') ??
        (saved?.modelSource !== undefined ? 'agent-default' : 'adapter-default'),
      model: selected('model') ?? (values.model !== null ? 'agent-default' : 'adapter-default'),
      supplierId: selected('supplierId') ?? 'adapter-default',
      effort: selected('effort') ?? (values.effort !== null ? 'agent-default' : 'adapter-default'),
    },
  };
  return { ...snapshot, fingerprint: fingerprint(snapshot) };
}

export function selectionMatchesConversation(
  snapshot: DelegationSelectionSnapshot,
  conversation: Conversation | undefined
): boolean {
  return (
    !!conversation &&
    stableStringify(snapshot.values) === stableStringify(valuesOf(conversation)) &&
    fingerprint({
      version: snapshot.version,
      values: snapshot.values,
      sources: snapshot.sources,
    }) === snapshot.fingerprint
  );
}
