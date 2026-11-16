import { createHash } from 'node:crypto';
import { KeyedMutex } from '@emdash/shared/concurrency';
import { redactSecrets } from '@emdash/shared/logger';
import { createEventStreamHost } from '@emdash/wire/live';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { PullRequestError } from '@core/services/pull-requests/api/errors';
import { sourceControlContract } from '../api/contract';
import {
  taskPullRequestInputSchema,
  taskPullRequestPlanSchema,
  taskPullRequestRecord,
  type TaskPullRequestInput,
  type TaskPullRequestPlan,
  type TaskPullRequestRecord,
} from '../api/task-pull-requests';

export type TaskPullRequestDependencies = {
  store: {
    getOrThrow(key: string): Promise<TaskPullRequestRecord | null>;
    setOrThrow(key: string, value: TaskPullRequestRecord): Promise<void>;
    getAll(): Promise<Record<string, TaskPullRequestRecord | undefined>>;
  };
  authorize(taskId: string, caller?: AgentCaller, intent?: 'read' | 'control'): Promise<void>;
  prepare(input: TaskPullRequestInput): Promise<TaskPullRequestPlan>;
  check(plan: TaskPullRequestPlan, published?: boolean): Promise<void>;
  push(plan: TaskPullRequestPlan): Promise<void>;
  ensure(plan: TaskPullRequestPlan): Promise<{ url: string; number: number }>;
  associate?(plan: TaskPullRequestPlan, result: { url: string; number: number }): Promise<void>;
  changed?(taskId: string): void;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class TaskPullRequestFailure extends Error {
  constructor(readonly detail: PullRequestError) {
    super('message' in detail ? detail.message : `Task PR creation failed: ${detail.type}`);
  }
}

/** A task owns the request across receiver changes; authorization is checked on every step. */
export class TaskPullRequestService {
  readonly events = createEventStreamHost(sourceControlContract.taskPullRequests.events);
  private readonly tasks = new KeyedMutex();
  constructor(private readonly deps: TaskPullRequestDependencies) {}
  private key(taskId: string, requestId: string) {
    return hash([taskId, requestId]);
  }
  private parse(value: unknown) {
    const parsed = taskPullRequestRecord.safeParse(value);
    if (parsed.status !== 'ok') throw new Error(`Cannot read task PR request: ${parsed.status}`);
    const record = taskPullRequestRecord.schema.parse(parsed.data);
    if (record.phase === 'complete' && !record.result)
      throw new Error('The completed task PR request has no saved receipt.');
    return record;
  }
  private async save(key: string, record: TaskPullRequestRecord) {
    await this.deps.store.setOrThrow(key, record);
    this.events.emit(undefined, { taskId: record.plan.taskId });
    this.deps.changed?.(record.plan.taskId);
  }
  async list(taskId: string, caller?: AgentCaller): Promise<TaskPullRequestRecord[]> {
    await this.deps.authorize(taskId, caller, 'read');
    const records = [];
    for (const value of Object.values(await this.deps.store.getAll())) {
      if (value?.plan?.taskId === taskId) records.push(this.parse(value));
    }
    return records;
  }
  async repositoryTargets(projectId: string): Promise<string[]> {
    const targets = new Set<string>();
    for (const value of Object.values(await this.deps.store.getAll())) {
      if (value?.plan?.projectId === projectId) targets.add(this.parse(value).plan.repositoryUrl);
    }
    return [...targets];
  }
  async prepare(input: TaskPullRequestInput, caller?: AgentCaller): Promise<TaskPullRequestRecord> {
    const selected = taskPullRequestInputSchema.parse(input);
    return this.tasks.runExclusive(selected.taskId, async () => {
      await this.deps.authorize(selected.taskId, caller, 'control');
      const key = this.key(selected.taskId, selected.requestId);
      // Schema order gives equivalent object inputs one fingerprint regardless of property order.
      const fingerprintInput = { ...selected };
      // Absent and true both mean push; retain fingerprints saved before this optional choice.
      if (fingerprintInput.push !== false) delete fingerprintInput.push;
      const fingerprint = hash(fingerprintInput);
      const saved = await this.deps.store.getOrThrow(key);
      if (saved) {
        const record = this.parse(saved);
        if (record.fingerprint !== fingerprint)
          throw new Error('This PR request_id has different parameters. Reuse its saved input.');
        return record;
      }
      const plan = taskPullRequestPlanSchema.parse(await this.deps.prepare(selected));
      if (plan.taskId !== selected.taskId) throw new Error('The prepared PR task does not match.');
      const record: TaskPullRequestRecord = {
        version: '2',
        requestId: selected.requestId,
        fingerprint,
        plan,
        phase: 'prepared',
      };
      await this.save(key, record);
      return record;
    });
  }
  async run(
    taskId: string,
    requestId: string,
    caller?: AgentCaller
  ): Promise<TaskPullRequestRecord> {
    return this.tasks.runExclusive(taskId, async () => {
      await this.deps.authorize(taskId, caller, 'control');
      const key = this.key(taskId, requestId);
      const saved = await this.deps.store.getOrThrow(key);
      if (!saved) throw new Error('Prepare this task PR request before executing it.');
      let record = this.parse(saved);
      if (record.plan.taskId !== taskId || record.requestId !== requestId)
        throw new Error('The saved task PR request does not match.');
      if (record.phase === 'complete') return record;
      try {
        await this.deps.check(record.plan);
        if (record.phase === 'prepared' || record.phase === 'pushing') {
          await this.deps.authorize(taskId, caller, 'control');
          if (record.plan.push !== false) {
            record = { ...record, phase: 'pushing', error: undefined, failure: undefined };
            await this.save(key, record);
            await this.deps.push(record.plan);
          }
          record = { ...record, phase: 'pushed', error: undefined, failure: undefined };
          await this.save(key, record);
        }
        await this.deps.authorize(taskId, caller, 'control');
        await this.deps.check(record.plan, true);
        record = { ...record, phase: 'creating', error: undefined, failure: undefined };
        await this.save(key, record);
        const result = record.result ?? (await this.deps.ensure(record.plan));
        // Persist the receipt before association: a failed breadcrumb cannot cause another create.
        record = { ...record, result };
        await this.save(key, record);
        await this.deps.associate?.(record.plan, result);
        record = { ...record, phase: 'complete' };
        await this.save(key, record);
        return record;
      } catch (error) {
        // Only add the diagnostic to the last durable step, never publish unsaved in-memory progress.
        const persisted = await this.deps.store.getOrThrow(key);
        if (persisted) {
          const authoritative = this.parse(persisted);
          await this.save(key, {
            ...authoritative,
            error: redactSecrets(String(error)),
            failure: error instanceof TaskPullRequestFailure ? error.detail : undefined,
          });
        }
        throw error;
      }
    });
  }
  async create(input: TaskPullRequestInput, caller?: AgentCaller) {
    await this.prepare(input, caller);
    return this.run(input.taskId, input.requestId, caller);
  }
}
