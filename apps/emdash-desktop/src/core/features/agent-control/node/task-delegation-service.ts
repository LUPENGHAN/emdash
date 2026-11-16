import { createHash, randomUUID } from 'node:crypto';
import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { KeyedMutex } from '@emdash/shared/concurrency';
import { z } from 'zod';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import type { AgentCaller, AgentControlAction, AgentControlResult } from '../api';
import type { DelegationResources } from '../api/node/delegation-resources';

export type CreateDelegatedTask = Extract<AgentControlAction, { kind: 'create_task' }>;
export const delegationRecord = defineVersionedSchema()
  .initial(
    '1',
    z.object({
      version: z.literal('1'),
      caller: z.custom<AgentCaller>(),
      request: z.custom<CreateDelegatedTask>(),
      fingerprint: z.string(),
      params: z.custom<CreateTaskParams>(),
      phase: z.enum(['prepared', 'created', 'activated', 'starting', 'started']),
      path: z.string().optional(),
      error: z.string().optional(),
    })
  )
  .build();
export type DelegationRecord = typeof delegationRecord.Type;

export type TaskDelegationDependencies = {
  store: {
    getOrThrow(key: string): Promise<DelegationRecord | null>;
    setOrThrow(key: string, value: DelegationRecord): Promise<void>;
    getAll(): Promise<Record<string, DelegationRecord | undefined>>;
  };
  authorize(caller: AgentCaller, projectId: string): Promise<void>;
  prepare(
    caller: AgentCaller,
    request: CreateDelegatedTask,
    ids: {
      taskId: string;
      conversationId: string;
      role?: 'coordination';
    }
  ): Promise<CreateTaskParams>;
  findTask(taskId: string, projectId: string): Promise<'missing' | 'available' | 'deleted'>;
  create(params: CreateTaskParams): Promise<void>;
  activate(taskId: string, projectId: string): Promise<{ path: string }>;
  /** Must attach to an observed session or start it idempotently, without replaying a prompt. */
  start(params: CreateTaskParams): Promise<void>;
  onPrepared?(caller: AgentCaller, params: CreateTaskParams): Promise<void>;
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

  async dispatch(caller: AgentCaller, request: CreateDelegatedTask): Promise<AgentControlResult> {
    const projectId = request.projectId ?? caller.projectId;
    await this.deps.authorize(caller, projectId);
    const requestId = request.requestId ?? randomUUID();
    const key = createHash('sha256')
      .update(JSON.stringify([caller.conversationId, requestId]))
      .digest('hex');
    return this.requests.runExclusive(key, async () => {
      const fingerprint = requestFingerprint(request, projectId);
      const saved = await this.deps.store.getOrThrow(key);
      let record: DelegationRecord;
      if (saved) {
        record = delegationRecord.schema.parse(saved);
        if (record.fingerprint !== fingerprint)
          throw new Error('This request_id already has different task parameters.');
      } else {
        const params = await this.deps.prepare(
          caller,
          { ...request, projectId },
          {
            taskId: randomUUID(),
            conversationId: randomUUID(),
          }
        );
        record = {
          version: '1',
          caller,
          request: { ...request, requestId, projectId },
          fingerprint,
          params,
          phase: 'prepared',
        };
        await this.deps.store.setOrThrow(key, record);
      }
      const persist = async (patch: Partial<DelegationRecord>) => {
        record = { ...record, ...patch, error: undefined };
        await this.deps.store.setOrThrow(key, record);
      };
      try {
        await this.deps.onPrepared?.(caller, record.params);
        const state = await this.deps.findTask(record.params.id, projectId);
        if (state === 'deleted')
          throw new Error(
            'The delegated task was deleted. Use another request_id to create a task.'
          );
        if (state === 'missing') {
          if (record.phase !== 'prepared')
            throw new Error('The delegated task record is missing; creation will not be replayed.');
          await this.deps.create(record.params);
        }
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
        return {
          text: JSON.stringify({
            request_id: requestId,
            task_id: record.params.id,
            project_id: projectId,
            conversation_id: record.params.taskConfig.initialConversation?.id,
            status: record.params.taskConfig.initialConversation
              ? 'agent_started'
              : 'workspace_ready',
            path: record.path,
            configuration: record.params.taskConfig.initialConversation,
          }),
        };
      } catch (error) {
        await this.deps.store.setOrThrow(key, {
          ...record,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async resumePending(onError: (error: unknown) => void): Promise<void> {
    for (const saved of Object.values(await this.deps.store.getAll())) {
      if (!saved) continue;
      try {
        const record = delegationRecord.schema.parse(saved);
        if (record.phase === 'started' || record.error) continue;
        await this.dispatch(record.caller, record.request);
      } catch (error) {
        onError(error);
      }
    }
  }
}
