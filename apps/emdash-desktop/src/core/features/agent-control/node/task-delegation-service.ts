import { createHash, randomUUID } from 'node:crypto';
import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { KeyedMutex } from '@emdash/shared/concurrency';
import { z } from 'zod';
import {
  projectBaselineSelectionSchema,
  type ProjectBaselineSelection,
} from '@core/features/projects/api/baseline-sync';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import type { AgentCaller, AgentControlAction, AgentControlResult } from '../api';
import type { TaskDelegationStatus } from '../api/delegations';
import type { DelegationResources } from '../api/node/delegation-resources';
import {
  delegationSelectionSnapshotSchema,
  type DelegationSelectionSnapshot,
} from '../api/selection-snapshot';
import { selectionMatchesConversation } from './selection-snapshot';

export type CreateDelegatedTask = Extract<AgentControlAction, { kind: 'create_task' }>;
export type PreparedTaskDelegation = CreateTaskParams & {
  /** The local source revision in params remains the executable input across retries. */
  baselineSelection?: ProjectBaselineSelection;
  selectionSnapshot?: DelegationSelectionSnapshot;
};
const preparedTaskDelegationSchema = z
  .custom<CreateTaskParams>()
  .and(
    z.object({
      baselineSelection: projectBaselineSelectionSchema.optional(),
      selectionSnapshot: delegationSelectionSnapshotSchema.optional(),
    })
  )
  .refine(
    (params) => {
      const selected = params.baselineSelection;
      if (!selected) return true;
      const git = params.workspaceConfig?.git;
      return (
        params.projectId === selected.target.projectId &&
        git?.kind === 'create-branch' &&
        git.fromBranch.type === 'local' &&
        git.fromBranch.branch === selected.oid
      );
    },
    { message: 'The delegation source does not match its approved baseline snapshot.' }
  )
  .refine(
    (params) =>
      !params.selectionSnapshot ||
      selectionMatchesConversation(params.selectionSnapshot, params.taskConfig.initialConversation),
    { message: 'The delegation launch selection does not match its frozen receipt.' }
  );
const delegationV1 = z.object({
  version: z.literal('1'),
  caller: z.custom<AgentCaller>(),
  request: z.custom<CreateDelegatedTask>(),
  fingerprint: z.string(),
  params: preparedTaskDelegationSchema,
  phase: z.enum(['prepared', 'created', 'activated', 'starting', 'started']),
  path: z.string().optional(),
  error: z.string().optional(),
});
export const delegationRecord = defineVersionedSchema()
  .initial('1', delegationV1)
  .version(
    '2',
    delegationV1.extend({ version: z.literal('2'), waitReason: z.string().optional() }),
    (record) => ({ ...record, version: '2' as const })
  )
  .build();
export type DelegationRecord = typeof delegationRecord.Type;

export type TaskDelegationDependencies = {
  store: {
    getOrThrow(key: string): Promise<DelegationRecord | null>;
    setOrThrow(key: string, value: DelegationRecord): Promise<void>;
    getAll(): Promise<Record<string, DelegationRecord | undefined>>;
  };
  authorize(caller: AgentCaller, projectId: string, request?: CreateDelegatedTask): Promise<void>;
  prepare(
    caller: AgentCaller,
    request: CreateDelegatedTask,
    ids: {
      taskId: string;
      conversationId: string;
      role?: 'coordination';
    }
  ): Promise<PreparedTaskDelegation>;
  findTask(taskId: string, projectId: string): Promise<'missing' | 'available' | 'deleted'>;
  create(params: CreateTaskParams): Promise<void>;
  activate(taskId: string, projectId: string): Promise<{ path: string }>;
  /** Must attach to an observed session or start it idempotently, without replaying a prompt. */
  start(params: CreateTaskParams): Promise<void>;
  getBlocker?(taskId: string): Promise<string | null>;
  onCreated?(taskId: string): Promise<void>;
  recoveryContext?(
    params: CreateTaskParams,
    fallback: AgentCaller
  ): Promise<{ caller: AgentCaller; projectGrants?: string[] }>;
  onStateChange?(taskId: string): void;
  onPrepared?(
    caller: AgentCaller,
    params: CreateTaskParams,
    request: CreateDelegatedTask
  ): Promise<void>;
};

function requestFingerprint(request: CreateDelegatedTask, projectId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        projectId,
        request.name,
        request.baseBranch,
        request.prompt,
        request.providerId,
        request.model,
        request.supplierId,
        request.connection,
        request.effort,
        request.ui,
        ...(request.projectGrants?.length ? [[...new Set(request.projectGrants)].sort()] : []),
        ...(request.dependsOn?.length
          ? [{ dependsOn: [...new Set(request.dependsOn)].sort() }]
          : []),
        ...(request.documentRefs?.length
          ? [
              {
                documentRefs: request.documentRefs.map((ref) => [
                  ref.coordinatorId,
                  ref.path,
                  ref.revision,
                ]),
              },
            ]
          : []),
      ])
    )
    .digest('hex');
}

/** Durable creation and launch steps. Window state never decides task existence. */
export class TaskDelegationService {
  private readonly requests = new KeyedMutex();
  constructor(private readonly deps: TaskDelegationDependencies) {}
  get resources(): DelegationResources {
    return this.deps;
  }
  private parseRecord(value: unknown): DelegationRecord {
    const parsed = delegationRecord.safeParse(value);
    if (parsed.status !== 'ok') throw new Error(`Cannot read delegation record: ${parsed.status}`);
    return delegationRecord.schema.parse(parsed.data);
  }
  private async saveRecord(key: string, record: DelegationRecord) {
    await this.deps.store.setOrThrow(key, record);
    this.deps.onStateChange?.(record.params.id);
  }
  private async forTask(taskId: string) {
    const matches = Object.entries(await this.deps.store.getAll()).filter(
      ([, value]) => value?.params?.id === taskId
    );
    if (matches.length > 1)
      throw new Error('The task has multiple delegation records. Resolve them before retrying.');
    const match = matches[0];
    return match ? { key: match[0], record: this.parseRecord(match[1]) } : null;
  }
  async status(taskId: string): Promise<TaskDelegationStatus | null> {
    const saved = await this.forTask(taskId);
    if (!saved) return null;
    return {
      taskId,
      phase: saved.record.phase,
      conversationId: saved.record.params.taskConfig.initialConversation?.id,
      path: saved.record.path,
      error: saved.record.error,
      waitReason: saved.record.waitReason,
      canRetry: !!saved.record.error && saved.record.phase !== 'started',
      ...(saved.record.params.selectionSnapshot && {
        selectionSnapshot: saved.record.params.selectionSnapshot,
      }),
      ...(saved.record.params.baselineSelection && {
        baselineSelection: saved.record.params.baselineSelection,
      }),
    };
  }
  private async context(record: DelegationRecord) {
    const context = await this.deps.recoveryContext?.(record.params, record.caller);
    return {
      caller: context?.caller ?? record.caller,
      request:
        context?.projectGrants !== undefined
          ? { ...record.request, projectGrants: context.projectGrants }
          : record.request,
    };
  }
  async retry(caller: AgentCaller, taskId: string): Promise<AgentControlResult> {
    const saved = await this.forTask(taskId);
    if (!saved) throw new Error('The task has no saved delegation to retry.');
    return this.requests.runExclusive(saved.key, async () => {
      const latest = await this.deps.store.getOrThrow(saved.key);
      if (!latest) throw new Error('The task delegation no longer exists.');
      const record = this.parseRecord(latest);
      if (record.params.id !== taskId) throw new Error('The task delegation changed.');
      const current = await this.context(record);
      if (caller.taskId !== current.caller.taskId || caller.projectId !== current.caller.projectId)
        throw new Error('Only a conversation in the responsible main agent can retry this task.');
      await this.deps.authorize(caller, record.params.projectId, current.request);
      return this.execute(saved.key, record, caller, current.request);
    });
  }
  async dispatch(caller: AgentCaller, request: CreateDelegatedTask): Promise<AgentControlResult> {
    const projectId = request.projectId ?? caller.projectId;
    await this.deps.authorize(caller, projectId, request);
    const requestId = request.requestId ?? randomUUID();
    const key = createHash('sha256')
      .update(JSON.stringify([caller.taskId, requestId]))
      .digest('hex');
    return this.requests.runExclusive(key, async () => {
      const fingerprint = requestFingerprint(request, projectId);
      const saved = await this.deps.store.getOrThrow(key);
      let record: DelegationRecord;
      if (saved) {
        record = this.parseRecord(saved);
        if (record.fingerprint !== fingerprint)
          throw new Error('This request_id already has different task parameters.');
      } else {
        const params = await this.deps.prepare(
          caller,
          { ...request, projectId },
          { taskId: randomUUID(), conversationId: randomUUID() }
        );
        record = {
          version: '2',
          caller,
          request: { ...request, requestId, projectId },
          fingerprint,
          params,
          phase: 'prepared',
        };
        await this.saveRecord(key, record);
      }
      return this.execute(key, record, caller, record.request);
    });
  }
  private async execute(
    key: string,
    initial: DelegationRecord,
    caller: AgentCaller,
    request: CreateDelegatedTask
  ): Promise<AgentControlResult> {
    let record = initial;
    const projectId = record.params.projectId;
    const persist = async (patch: Partial<DelegationRecord>) => {
      record = { ...record, error: undefined, waitReason: undefined, ...patch };
      await this.saveRecord(key, record);
    };
    const reply = (blocked = false) => ({
      text: JSON.stringify({
        request_id: record.request.requestId,
        task_id: record.params.id,
        project_id: projectId,
        conversation_id: record.params.taskConfig.initialConversation?.id,
        status: blocked
          ? 'blocked'
          : record.params.taskConfig.initialConversation
            ? 'agent_started'
            : 'workspace_ready',
        path: record.path,
        ...('branchName' in record.params.workspaceConfig.git
          ? {
              [blocked ? 'planned_branch' : 'branch']: record.params.workspaceConfig.git.branchName,
            }
          : {}),
        waiting_for: record.waitReason,
        configuration: record.params.taskConfig.initialConversation,
        selection_snapshot: record.params.selectionSnapshot,
      }),
    });
    try {
      await this.deps.onPrepared?.(caller, record.params, request);
      if (record.phase !== 'started') {
        const reason = await this.deps.getBlocker?.(record.params.id);
        if (reason) {
          await persist({ waitReason: reason });
          return reply(true);
        }
      }
      const state = await this.deps.findTask(record.params.id, projectId);
      if (state === 'deleted')
        throw new Error('The delegated task was deleted. Use another request_id to create a task.');
      if (state === 'missing') {
        if (record.phase !== 'prepared')
          throw new Error('The delegated task record is missing; creation will not be replayed.');
        await this.deps.create(record.params);
      }
      await this.deps.onCreated?.(record.params.id);
      if (record.phase === 'prepared') await persist({ phase: 'created' });
      if (record.phase !== 'started') {
        const activation = await this.deps.activate(record.params.id, projectId);
        await persist({ phase: 'activated', path: activation.path });
        if (record.params.taskConfig.initialConversation) {
          await persist({ phase: 'starting' });
          await this.deps.start(record.params);
        }
        await persist({ phase: 'started' });
      }
      return reply();
    } catch (error) {
      await this.saveRecord(key, {
        ...record,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  async resumePending(onError: (error: unknown) => void): Promise<void> {
    for (const [key, saved] of Object.entries(await this.deps.store.getAll())) {
      if (!saved) continue;
      try {
        await this.requests.runExclusive(key, async () => {
          const latest = await this.deps.store.getOrThrow(key);
          if (!latest) return;
          const record = this.parseRecord(latest);
          if (record.phase === 'started' || record.error) return;
          const { caller, request } = await this.context(record);
          await this.deps.authorize(caller, record.params.projectId, request);
          await this.execute(key, record, caller, request);
        });
      } catch (error) {
        onError(error);
      }
    }
  }
}
