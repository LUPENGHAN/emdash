import { createHash, randomUUID } from 'node:crypto';
import { KeyedMutex } from '@emdash/shared/concurrency';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { DelegationResources } from '@core/features/agent-control/api/node/delegation-resources';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import {
  taskResultSchema,
  coordinatorRecord,
  type AgentSelection,
  type Coordinator,
  type CoordinationEvent,
  type TaskResult,
  type ResolvedAgentSelection,
  type ProjectAccess,
} from '../api/types';
import { coordinatorPrincipal, mayAccessProject, mayAccessTask } from './coordinator-access';

type Dependencies = {
  store: {
    getOrThrow(id: string): Promise<Coordinator | null>;
    setOrThrow(id: string, value: Coordinator): Promise<void>;
    getAll(): Promise<Record<string, Coordinator | undefined>>;
  };
  resources(): DelegationResources;
  defaultAgent(): Promise<string>;
  resolveSelection(selection: AgentSelection): Promise<ResolvedAgentSelection>;
  getConversation(id: string): Promise<{
    taskId: string;
    projectId: string;
    selection: AgentSelection;
  } | null>;
  assertProjectAvailable(projectId: string): Promise<void>;
  setTaskStatus(taskId: string, status: 'review' | 'done' | 'in_progress'): Promise<void>;
  deliver(coordinator: Coordinator, eventId: string, text: string): Promise<void>;
  emit(event: CoordinationEvent): void;
  reportError?(error: unknown, id: string): void;
};

const instruction = `You are this project's main agent. Coordinate existing Emdash tasks through MCP.
Delegate implementation into task worktrees; keep code changes on their own branches.
Specify a stable request_id when creating a task and reuse it for retries. You may select agent, supplier_id, model and effort.
Workers must call submit_task_result with commits, checks and unresolved issues. Inspect their changes and evidence before reviewing a result.
When a result notification arrives, call acknowledge_task_results with its event IDs before taking follow-up actions.
Agent startup, an idle process and a created PR do not prove task completion. Do not automatically merge branches or PRs.`;

export class CoordinatorService {
  private readonly locks = new KeyedMutex();
  private readonly deliveries = new KeyedMutex();
  constructor(private readonly deps: Dependencies) {}
  async list(): Promise<Coordinator[]> {
    const records: Coordinator[] = [];
    for (const [id, value] of Object.entries(await this.deps.store.getAll())) {
      if (!value) continue;
      try {
        records.push(this.parseRecord(value));
      } catch (error) {
        this.deps.reportError?.(error, id);
      }
    }
    return records;
  }
  async ensureProject(projectId: string): Promise<Coordinator> {
    const id = `project:${projectId}`;
    return this.locks.runExclusive(id, async () => {
      const saved = await this.deps.store.getOrThrow(id);
      if (saved) return this.parseRecord(saved);
      const record: Coordinator = {
        version: '2',
        id,
        kind: 'project',
        name: 'Main agent',
        projectId,
        projectIds: [projectId],
        taskId: randomUUID(),
        conversationId: randomUUID(),
        primary: { agent: await this.deps.defaultAgent() },
        delegationDefaults: {},
        tasks: {},
        events: [],
      };
      await this.save(record);
      return record;
    });
  }
  async getByTask(taskId: string): Promise<Coordinator | null> {
    return (await this.list()).find((record) => record.taskId === taskId) ?? null;
  }
  async instructionsForTask(taskId: string): Promise<string | undefined> {
    const records = await this.list();
    if (records.some((record) => record.taskId === taskId)) return instruction;
    if (records.some((record) => record.tasks[taskId]))
      return `You are executing delegated Emdash task ${taskId}.
Keep code on this task's branch. Before finishing, call submit_task_result with this task ID,
a stable request_id, a summary, commit references, checks actually run and unresolved issues.
Do not mark the task complete yourself. The responsible main agent reviews your result.`;
    return undefined;
  }
  private parseRecord(value: unknown): Coordinator {
    const parsed = coordinatorRecord.safeParse(value);
    if (parsed.status !== 'ok') throw new Error(`Cannot read coordinator record: ${parsed.status}`);
    return coordinatorRecord.schema.parse(parsed.data);
  }
  private async get(id: string): Promise<Coordinator> {
    const record = await this.deps.store.getOrThrow(id);
    if (!record) throw new Error('The main agent no longer exists.');
    return this.parseRecord(record);
  }
  private async save(record: Coordinator): Promise<void> {
    await this.deps.store.setOrThrow(record.id, coordinatorRecord.schema.parse(record));
    this.deps.emit({ coordinatorId: record.id, projectId: record.projectId });
  }
  async openProject(projectId: string): Promise<Coordinator> {
    await this.deps.assertProjectAvailable(projectId);
    const record = await this.ensureProject(projectId);
    return this.open(record.id);
  }
  async open(id: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      let record = await this.get(id);
      await this.deps.assertProjectAvailable(record.projectId);
      const runtime = this.deps.resources();
      const state = await runtime.findTask(record.taskId, record.projectId);
      if (state === 'deleted')
        throw new Error(
          'The main agent runtime was removed. Restore its project before opening it.'
        );
      if (!record.params) {
        const params = await runtime.prepare(
          {
            conversationId: record.conversationId,
            taskId: record.taskId,
            projectId: record.projectId,
            providerId: record.primary.agent ?? (await this.deps.defaultAgent()),
            title: record.name,
            cwd: null,
          },
          {
            kind: 'create_task',
            projectId: record.projectId,
            name: record.name,
            prompt: instruction,
            providerId: record.primary.agent,
            connection: record.primary.connection,
            supplierId: record.primary.supplierId,
            model: record.primary.model,
            effort: record.primary.effort,
            ui: 'chat',
          },
          { taskId: record.taskId, conversationId: record.conversationId, role: 'coordination' }
        );
        params.taskConfig.role = 'coordination';
        if (params.workspaceConfig.git.kind !== 'create-branch')
          throw new Error('A main agent needs an isolated workspace.');
        params.workspaceConfig.git.branchName = `emdash/manage/${record.taskId}`;
        // The first turn is user initiated. Instructions are delivered as hidden context on that turn.
        if (params.taskConfig.initialConversation) {
          params.taskConfig.initialConversation.initialQueue = undefined;
          params.taskConfig.initialConversation.initialPrompt = undefined;
        }
        record = { ...record, params };
        await this.save(record);
      }
      if (state === 'missing') await runtime.create(record.params!);
      await runtime.activate(record.taskId, record.projectId);
      return record;
    });
  }
  async update(
    id: string,
    patch: {
      primary?: AgentSelection;
      delegationDefaults?: AgentSelection;
      projectAccess?: ProjectAccess;
      projectIds?: string[];
    }
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (patch.projectAccess?.mode === 'selected')
        for (const projectId of patch.projectAccess.projectIds)
          await this.deps.assertProjectAvailable(projectId);
      if (patch.projectIds)
        for (const projectId of patch.projectIds) await this.deps.assertProjectAvailable(projectId);
      if (patch.primary && record.params)
        throw new Error('Change the active main conversation through its session settings.');
      for (const selection of [patch.primary, patch.delegationDefaults]) {
        if (!selection) continue;
        const resolved = await this.deps.resolveSelection(selection);
        if (resolved.errors.length) throw new Error(resolved.errors.join(' '));
      }
      const next = { ...record, ...patch };
      await this.save(next);
      return next;
    });
  }
  async selectionOptions(id: string, selection: AgentSelection): Promise<ResolvedAgentSelection> {
    const record = await this.get(id);
    await this.deps.assertProjectAvailable(record.projectId);
    return this.deps.resolveSelection(selection);
  }
  async bindConversation(id: string, conversationId: string): Promise<Coordinator> {
    const record = await this.deliveries.runExclusive(id, () =>
      this.locks.runExclusive(id, async () => {
        const latest = await this.get(id);
        await this.deps.assertProjectAvailable(latest.projectId);
        const conversation = await this.deps.getConversation(conversationId);
        if (
          !conversation ||
          conversation.taskId !== latest.taskId ||
          conversation.projectId !== latest.projectId
        )
          throw new Error('Choose an available conversation belonging to this main agent.');
        if (latest.conversationId === conversationId) return latest;
        latest.conversationId = conversationId;
        latest.primary = conversation.selection;
        for (const event of latest.events)
          if (event.state !== 'acknowledged') {
            event.state = 'pending';
            event.error = undefined;
          }
        await this.save(latest);
        return latest;
      })
    );
    void this.deliverPending(id).catch((error) => this.deps.reportError?.(error, id));
    return record;
  }
  async defaultsForCaller(caller: AgentCaller): Promise<AgentSelection> {
    const record = (await this.list()).find(
      (entry) => entry.taskId === caller.taskId || entry.tasks[caller.taskId]
    );
    if (!record) return {};
    return {
      ...record.delegationDefaults,
      agent: record.delegationDefaults.agent ?? (await this.deps.defaultAgent()),
    };
  }

  async getTaskCoordination(taskId: string) {
    const record = (await this.list()).find(
      (entry) => entry.taskId === taskId || entry.tasks[taskId]
    );
    if (!record) return null;
    return {
      coordinatorId: record.id,
      mainTaskId: record.taskId,
      mainConversationId: record.conversationId,
      assignment: record.tasks[taskId] ?? null,
    };
  }
  async mayAccessProject(
    caller: AgentCaller,
    projectId: string,
    intent: 'read' | 'delegate'
  ): Promise<boolean> {
    const records = await this.list();
    return mayAccessProject(caller, coordinatorPrincipal(caller, records), projectId, intent);
  }
  async mayAccessTask(
    caller: AgentCaller,
    target: { id: string; projectId: string },
    intent: 'read' | 'control'
  ): Promise<boolean> {
    return mayAccessTask(caller, await this.list(), target, intent);
  }
  async assertDelegationGrants(caller: AgentCaller, projectIds: string[]): Promise<void> {
    const records = await this.list();
    const principal = coordinatorPrincipal(caller, records);
    if (projectIds.length && principal.kind === 'ordinary')
      throw new Error('Project grants require a responsible main agent.');
    for (const projectId of projectIds) {
      if (!mayAccessProject(caller, principal, projectId, 'delegate'))
        throw new Error(`Project permission denied: ${projectId}`);
      await this.deps.assertProjectAvailable(projectId);
    }
  }
  async registerDelegation(
    caller: AgentCaller,
    params: CreateTaskParams,
    grantedProjectIds: string[] = []
  ): Promise<void> {
    await this.assertDelegationGrants(caller, grantedProjectIds);
    const record = (await this.list()).find(
      (entry) => entry.taskId === caller.taskId || entry.tasks[caller.taskId]
    );
    if (!record) return;
    await this.locks.runExclusive(record.id, async () => {
      const latest = await this.get(record.id);
      if (latest.tasks[params.id]) return;
      latest.tasks[params.id] = {
        taskId: params.id,
        projectId: params.projectId,
        name: params.taskConfig.name,
        state: 'assigned',
        resultVersion: 0,
        submissions: {},
        ...(grantedProjectIds.length && { grantedProjectIds: [...new Set(grantedProjectIds)] }),
      };
      await this.save(latest);
    });
  }
  async submit(
    caller: AgentCaller,
    taskId: string,
    requestId: string,
    input: TaskResult
  ): Promise<{ eventId: string; version: number }> {
    const record = (await this.list()).find((entry) => entry.tasks[taskId]);
    if (
      !record ||
      (caller.taskId !== taskId &&
        (caller.taskId !== record.taskId || caller.conversationId !== record.conversationId))
    )
      throw new Error('This task is not assigned to this caller.');
    const result = taskResultSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const receipt = await this.locks.runExclusive(record.id, async () => {
      const latest = await this.get(record.id);
      if (
        caller.taskId !== taskId &&
        (caller.taskId !== latest.taskId || caller.conversationId !== latest.conversationId)
      )
        throw new Error('Only the responsible main conversation can submit another task result.');
      const task = latest.tasks[taskId];
      const previous = task.submissions[requestId];
      if (previous && previous.fingerprint !== fingerprint)
        throw new Error('This result request_id has different content.');
      if (previous) {
        const event = latest.events.find(
          (entry) => entry.taskId === taskId && entry.version === previous.version
        );
        if (!event) throw new Error('The result notification is missing.');
        if (task.state === 'review' && task.resultVersion === previous.version)
          await this.deps.setTaskStatus(taskId, 'review');
        return { eventId: event.id, version: previous.version };
      }
      const version = task.resultVersion + 1;
      const eventId = randomUUID();
      task.result = result;
      task.resultVersion = version;
      task.state = 'review';
      task.review = undefined;
      task.submissions[requestId] = { version, fingerprint };
      latest.events.push({ id: eventId, taskId, version, result, state: 'pending' });
      await this.save(latest);
      await this.deps.setTaskStatus(taskId, 'review');
      return { eventId, version };
    });
    void this.deliverPending(record.id).catch(() => {});
    return receipt;
  }
  async acknowledge(caller: AgentCaller, eventIds: string[]): Promise<void> {
    const record = await this.getByTask(caller.taskId);
    if (!record || record.conversationId !== caller.conversationId)
      throw new Error('Only the responsible main conversation can acknowledge results.');
    await this.locks.runExclusive(record.id, async () => {
      const latest = await this.get(record.id);
      if (latest.conversationId !== caller.conversationId)
        throw new Error('Only the responsible main conversation can acknowledge results.');
      if (eventIds.some((id) => !latest.events.some((event) => event.id === id)))
        throw new Error('Unknown result event ID.');
      for (const event of latest.events)
        if (eventIds.includes(event.id)) event.state = 'acknowledged';
      await this.save(latest);
    });
  }
  async review(
    id: string,
    taskId: string,
    accepted: boolean,
    note: string,
    resultVersion: number,
    caller?: AgentCaller
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (
        caller &&
        (caller.taskId !== record.taskId || caller.conversationId !== record.conversationId)
      )
        throw new Error('Only the responsible main conversation can review this task.');
      const task = record.tasks[taskId];
      if (!task?.result) throw new Error('This task has no submitted result to review.');
      if (task.resultVersion !== resultVersion)
        throw new Error('The result changed. Review the latest version before accepting.');
      task.state = accepted ? 'done' : 'changes_requested';
      task.review = { note, accepted, at: Date.now() };
      await this.save(record);
      await this.deps.setTaskStatus(taskId, accepted ? 'done' : 'in_progress');
      return record;
    });
  }
  /** Restores unconfirmed notifications after process restart and repairs task status projections. */
  async recover(): Promise<void> {
    for (const record of await this.list()) {
      try {
        await this.locks.runExclusive(record.id, async () => {
          const latest = await this.get(record.id);
          for (const event of latest.events) if (event.state === 'queued') event.state = 'pending';
          await this.save(latest);
          for (const task of Object.values(latest.tasks)) {
            if (task.state === 'assigned') continue;
            const status = task.state === 'changes_requested' ? 'in_progress' : task.state;
            try {
              await this.deps.setTaskStatus(task.taskId, status);
            } catch (error) {
              this.deps.reportError?.(error, task.taskId);
            }
          }
        });
        await this.deliverPending(record.id);
      } catch (error) {
        this.deps.reportError?.(error, record.id);
      }
    }
  }
  async deliverPending(id: string): Promise<void> {
    await this.deliveries.runExclusive(id, async () => {
      const record = await this.get(id);
      for (const event of record.events.filter((entry) => entry.state === 'pending')) {
        // Acknowledgments can arrive while another event is being delivered.
        const current = (await this.get(id)).events.find((entry) => entry.id === event.id);
        if (current?.state !== 'pending') continue;
        const result = event.result;
        try {
          await this.deps.deliver(
            record,
            event.id,
            `${instruction}\nResult event ${event.id}, task ${event.taskId}, version ${event.version}:\n${JSON.stringify(result)}`
          );
          await this.locks.runExclusive(id, async () => {
            const latest = await this.get(id);
            const saved = latest.events.find((entry) => entry.id === event.id);
            if (saved?.state === 'pending') saved.state = 'queued';
            if (saved) saved.error = undefined;
            await this.save(latest);
          });
        } catch (error) {
          await this.locks.runExclusive(id, async () => {
            const latest = await this.get(id);
            const saved = latest.events.find((entry) => entry.id === event.id);
            if (saved?.state === 'pending')
              saved.error = error instanceof Error ? error.message : String(error);
            await this.save(latest);
          });
        }
      }
    });
  }
}
