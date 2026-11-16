import { createHash, randomUUID } from 'node:crypto';
import { KeyedMutex } from '@emdash/shared/concurrency';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { DelegationResources } from '@core/features/agent-control/api/node/delegation-resources';
import type { CreateTaskParams, Task } from '@core/primitives/tasks/api';
import {
  taskResultSchema,
  agentSelectionSchema,
  coordinatorRecord,
  type AgentSelection,
  type AssignedTask,
  type Coordinator,
  type CoordinationEvent,
  type TaskResult,
  type ResolvedAgentSelection,
  type ProjectAccess,
  type TakeoverPreview,
} from '../api/types';
import { coordinatorPrincipal, mayAccessProject, mayAccessTask } from './coordinator-access';

type Dependencies = {
  store: {
    getOrThrow(id: string): Promise<Coordinator | null>;
    setOrThrow(id: string, value: Coordinator): Promise<void>;
    setManyOrThrow(entries: { key: string; value: Coordinator }[]): Promise<void>;
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
  getTask(
    id: string
  ): Promise<Pick<Task, 'id' | 'projectId' | 'name' | 'type' | 'archivedAt'> | null>;
  assertProjectAvailable(projectId: string): Promise<void>;
  setTaskStatus(taskId: string, status: 'review' | 'done' | 'in_progress'): Promise<void>;
  deliver(
    coordinator: Coordinator,
    eventId: string,
    text: string,
    hiddenContext?: string
  ): Promise<void>;
  emit(event: CoordinationEvent): void;
  onSchedulingChange?(): void;
  reportError?(error: unknown, id: string): void;
};

const instruction = `You are this project's main agent. Coordinate existing Emdash tasks through MCP.
Delegate implementation into task worktrees; keep code changes on their own branches.
Specify a stable request_id when creating a task and reuse it for retries. You may select agent, supplier_id, model and effort. Use depends_on for tasks that must wait for approved prerequisite results.
Workers must call submit_task_result with commits, checks and unresolved issues. Inspect their changes and evidence before reviewing a result.
When a result notification arrives, call acknowledge_task_results with its event IDs before taking follow-up actions.
Agent startup, an idle process and a created PR do not prove task completion. Do not automatically merge branches or PRs.`;

export class CoordinatorService {
  private readonly locks = new KeyedMutex();
  private readonly deliveries = new KeyedMutex();
  private readonly ownership = new KeyedMutex();
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
        version: '5',
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
  async createCrossProject(input: {
    id: string;
    name: string;
    projectId: string;
    projectIds: string[];
    primary?: AgentSelection;
    delegationDefaults?: AgentSelection;
  }): Promise<Coordinator> {
    const id = `cross:${input.id}`;
    const name = input.name.trim();
    if (!name) throw new Error('Name the cross-project main agent.');
    const projectIds = [...new Set([input.projectId, ...input.projectIds])].sort();
    const primary = agentSelectionSchema.parse(input.primary ?? {});
    const delegationDefaults = agentSelectionSchema.parse(input.delegationDefaults ?? {});
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          name,
          projectId: input.projectId,
          projectIds,
          primary,
          delegationDefaults,
        })
      )
      .digest('hex');
    return this.locks.runExclusive(id, async () => {
      const saved = await this.deps.store.getOrThrow(id);
      if (saved) {
        const record = this.parseRecord(saved);
        if (record.creationFingerprint !== fingerprint)
          throw new Error('This creation request has different main agent parameters.');
        return record;
      }
      for (const projectId of projectIds) await this.deps.assertProjectAvailable(projectId);
      for (const selection of [primary, delegationDefaults]) {
        const resolved = await this.deps.resolveSelection(selection);
        if (resolved.errors.length) throw new Error(resolved.errors.join(' '));
      }
      const record: Coordinator = {
        version: '5',
        id,
        name,
        kind: 'cross-project',
        projectId: input.projectId,
        projectIds,
        taskId: randomUUID(),
        conversationId: randomUUID(),
        primary: { agent: await this.deps.defaultAgent(), ...primary },
        delegationDefaults,
        tasks: {},
        events: [],
        creationFingerprint: fingerprint,
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
    const assignment = records.find((record) => record.tasks[taskId])?.tasks[taskId];
    if (assignment)
      return `You are executing delegated Emdash task ${taskId}.
Keep code on this task's branch. Before finishing, call submit_task_result with this task ID,
a stable request_id, a summary, commit references, checks actually run and unresolved issues.
Do not mark the task complete yourself. The responsible main agent reviews your result.
Approved prerequisite versions: ${JSON.stringify(assignment.dependencyResults ?? [])}. These references do not install changes into this repository; consume the specified commits or versions explicitly.`;
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
    this.deps.emit({
      coordinatorId: record.id,
      projectId: record.projectId,
      taskId: record.taskId,
    });
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
        if (params.workspaceConfig.workspace.kind !== 'new-worktree')
          throw new Error('A main agent needs an isolated workspace.');
        params.workspaceConfig.git = {
          kind: 'management',
          branchName: `emdash/manage/${record.taskId}`,
        };
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
      if (patch.projectAccess) this.deps.onSchedulingChange?.();
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
    this.deps.onSchedulingChange?.();
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
  private async accessRecords(caller: AgentCaller, targetTaskId?: string): Promise<Coordinator[]> {
    const records: Coordinator[] = [];
    for (const value of Object.values(await this.deps.store.getAll())) {
      if (!value) continue;
      try {
        records.push(this.parseRecord(value));
      } catch (error) {
        if (
          value.taskId === caller.taskId ||
          value.tasks?.[caller.taskId] ||
          (targetTaskId && (value.taskId === targetTaskId || value.tasks?.[targetTaskId]))
        )
          throw error;
        this.deps.reportError?.(error, value.id);
      }
    }
    return records;
  }
  async mayAccessProject(
    caller: AgentCaller,
    projectId: string,
    intent: 'read' | 'delegate'
  ): Promise<boolean> {
    const records = await this.accessRecords(caller);
    return mayAccessProject(caller, coordinatorPrincipal(caller, records), projectId, intent);
  }
  async mayAccessTask(
    caller: AgentCaller,
    target: { id: string; projectId: string },
    intent: 'read' | 'control'
  ): Promise<boolean> {
    return mayAccessTask(caller, await this.accessRecords(caller, target.id), target, intent);
  }
  async assertDelegationGrants(caller: AgentCaller, projectIds: string[]): Promise<void> {
    const records = await this.accessRecords(caller);
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
    grantedProjectIds: string[] = [],
    dependsOn: string[] = []
  ): Promise<void> {
    await this.assertDelegationGrants(caller, grantedProjectIds);
    await this.ownership.runExclusive('ownership', async () => {
      const records = await this.accessRecords(caller, params.id);
      const record = records.find(
        (entry) => entry.taskId === caller.taskId || entry.tasks[caller.taskId]
      );
      if (!record) {
        if (dependsOn.length)
          throw new Error('Task dependencies require a responsible main agent.');
        return;
      }
      const owner = records.find((entry) => entry.tasks[params.id]);
      if (owner && owner.id !== record.id)
        throw new Error(
          'The task belongs to another main agent. Explicitly take it over before controlling it.'
        );
      await this.locks.runExclusive(record.id, async () => {
        const latest = await this.get(record.id);
        if (latest.tasks[params.id]) return;
        const principal = coordinatorPrincipal(caller, [latest]);
        if (
          principal.kind === 'ordinary' ||
          !mayAccessProject(caller, principal, params.projectId, 'delegate')
        )
          throw new Error(`Project permission denied: ${params.projectId}`);
        if (
          grantedProjectIds.some(
            (projectId) => !mayAccessProject(caller, principal, projectId, 'delegate')
          )
        )
          throw new Error('Worker project grants exceed the caller permissions.');
        await this.validateDependencies(caller, params.id, dependsOn, records);
        latest.tasks[params.id] = {
          taskId: params.id,
          projectId: params.projectId,
          name: params.taskConfig.name,
          state: dependsOn.length ? 'blocked' : 'assigned',
          dependsOn: [...new Set(dependsOn)],
          taskCreated: false,
          createdAt: Date.now(),
          ...(dependsOn.length && { blockedReason: 'Waiting for dependency review.' }),
          resultVersion: 0,
          submissions: {},
          ...(grantedProjectIds.length && { grantedProjectIds: [...new Set(grantedProjectIds)] }),
        };
        await this.save(latest);
      });
    });
  }
  private async validateDependencies(
    caller: AgentCaller,
    taskId: string,
    dependsOn: string[],
    records: Coordinator[]
  ): Promise<void> {
    const tasks = new Map(
      records.flatMap((record) =>
        Object.values(record.tasks).map((task) => [task.taskId, task] as const)
      )
    );
    for (const id of dependsOn) {
      const task = tasks.get(id);
      if (!task || id === taskId)
        throw new Error('Choose an existing coordinated task as a prerequisite.');
      if (!mayAccessTask(caller, records, { id, projectId: task.projectId }, 'read'))
        throw new Error('Dependency task permission denied.');
      const visit = (next: string, seen: Set<string>): boolean => {
        if (next === taskId) return true;
        if (seen.has(next)) return false;
        seen.add(next);
        return (tasks.get(next)?.dependsOn ?? []).some((id) => visit(id, seen));
      };
      if (visit(id, new Set())) throw new Error('Task dependencies would form a cycle.');
    }
  }
  async plannedTasks(projectId: string) {
    return (await this.list()).flatMap((record) =>
      Object.values(record.tasks).filter(
        (task) => task.projectId === projectId && task.taskCreated === false
      )
    );
  }
  async dependencyGate(taskId: string): Promise<string | null> {
    return this.ownership.runExclusive('ownership', async () => {
      const snapshot = await this.list();
      const owner = snapshot.find((record) => record.tasks[taskId]);
      const assignment = owner?.tasks[taskId];
      if (assignment?.state === 'cancelled') return 'This task was cancelled before startup.';
      if (!owner || !assignment?.dependsOn?.length || assignment.dependencyResults) return null;
      const dependencies = assignment.dependsOn;
      const ids = [
        owner.id,
        ...snapshot
          .filter((record) => dependencies.some((id) => record.tasks[id]))
          .map((record) => record.id),
      ];
      return this.underLocks(this.locks, ids, async () => {
        const records = await this.list();
        const latest = await this.get(owner.id);
        const task = latest.tasks[taskId];
        if (!task) throw new Error('The planned task is unavailable.');
        if (task.dependencyResults) return null;
        const actor: AgentCaller = {
          taskId: latest.taskId,
          projectId: latest.projectId,
          conversationId: latest.conversationId,
          providerId: latest.primary.agent ?? 'coordinator',
          title: latest.name,
          cwd: null,
        };
        const snapshots: NonNullable<AssignedTask['dependencyResults']> = [];
        for (const id of dependencies) {
          const predecessor = records.find((record) => record.tasks[id])?.tasks[id];
          if (
            predecessor &&
            !mayAccessTask(actor, records, { id, projectId: predecessor.projectId }, 'read')
          ) {
            const reason = `Dependency ${id} is outside the responsible main agent's project scope.`;
            task.state = 'blocked';
            task.blockedReason = reason;
            await this.save(latest);
            return reason;
          }
          const live = predecessor ? await this.deps.getTask(id) : null;
          if (
            !predecessor ||
            !live ||
            predecessor.state !== 'done' ||
            !predecessor.review?.accepted ||
            !predecessor.result
          ) {
            const reason =
              !predecessor || !live
                ? `Dependency ${id} is unavailable.`
                : `Waiting for review of ${predecessor.name}.`;
            if (task.state !== 'blocked' || task.blockedReason !== reason) {
              task.state = 'blocked';
              task.blockedReason = reason;
              await this.save(latest);
            }
            return reason;
          }
          snapshots.push({
            taskId: id,
            projectId: predecessor.projectId,
            version: predecessor.resultVersion,
            commits: predecessor.result.commits,
          });
        }
        task.dependencyResults = snapshots;
        task.state = 'assigned';
        task.blockedReason = undefined;
        await this.save(latest);
        return null;
      });
    });
  }
  async cancelPendingTask(id: string, taskId: string, caller?: AgentCaller): Promise<Coordinator> {
    return this.ownership.runExclusive('ownership', () =>
      this.locks.runExclusive(id, async () => {
        const record = await this.get(id);
        if (
          caller &&
          (caller.taskId !== record.taskId || caller.conversationId !== record.conversationId)
        )
          throw new Error('Only the responsible main conversation can cancel this planned task.');
        const task = record.tasks[taskId];
        if (!task || task.taskCreated !== false)
          throw new Error('Choose a waiting task that has not started.');
        if (task.state === 'cancelled') return record;
        if (task.state !== 'blocked' || task.dependencyResults)
          throw new Error('Task startup has been admitted. Stop it through its task workspace.');
        task.state = 'cancelled';
        task.blockedReason = 'Cancelled before startup.';
        await this.save(record);
        return record;
      })
    );
  }
  async markTaskCreated(taskId: string): Promise<void> {
    await this.ownership.runExclusive('ownership', async () => {
      const owner = (await this.list()).find((record) => record.tasks[taskId]);
      if (!owner) return;
      await this.locks.runExclusive(owner.id, async () => {
        const latest = await this.get(owner.id);
        const task = latest.tasks[taskId];
        if (!task || task.taskCreated === true) return;
        task.taskCreated = true;
        await this.save(latest);
      });
    });
  }
  private async codeTask(taskId: string, records: Coordinator[]) {
    const live = await this.deps.getTask(taskId);
    if (live) return live;
    const planned = records.find((record) => record.tasks[taskId])?.tasks[taskId];
    return planned?.taskCreated === false
      ? { id: taskId, projectId: planned.projectId, name: planned.name, type: 'task' as const }
      : null;
  }
  async recoveryContext(
    taskId: string,
    fallback: AgentCaller
  ): Promise<{ caller: AgentCaller; projectGrants?: string[] }> {
    const records = await this.accessRecords(fallback, taskId);
    const owner = records.find((record) => record.tasks[taskId]);
    if (!owner) return { caller: fallback };
    await this.deps.assertProjectAvailable(owner.projectId);
    const caller: AgentCaller = {
      taskId: owner.taskId,
      conversationId: owner.conversationId,
      projectId: owner.projectId,
      providerId: owner.primary.agent ?? fallback.providerId,
      title: owner.name,
      cwd: null,
    };
    return {
      caller,
      projectGrants: (owner.tasks[taskId].grantedProjectIds ?? []).filter((id) =>
        mayAccessProject(caller, { kind: 'main', coordinator: owner }, id, 'delegate')
      ),
    };
  }
  private underLocks<T>(mutex: KeyedMutex, ids: string[], action: () => Promise<T>): Promise<T> {
    const keys = [...new Set(ids)].sort();
    const run = (index: number): Promise<T> =>
      index === keys.length ? action() : mutex.runExclusive(keys[index], () => run(index + 1));
    return run(0);
  }
  async takeOverTask(
    id: string,
    taskId: string,
    expectedOwner: string | null,
    caller?: AgentCaller
  ): Promise<Coordinator> {
    const snapshot = await this.list();
    const previous = snapshot.find((record) => record.tasks[taskId]);
    const ids = previous && previous.id !== id ? [id, previous.id] : [id];
    const record = await this.underLocks(this.deliveries, ids, () =>
      this.ownership.runExclusive('ownership', () =>
        this.underLocks(this.locks, ids, async () => {
          // Ownership changes require a complete view; unknown records cannot be silently bypassed.
          const records = Object.values(await this.deps.store.getAll())
            .filter(Boolean)
            .map((value) => this.parseRecord(value));
          const next = records.find((entry) => entry.id === id);
          if (!next) throw new Error('The destination main agent is unavailable.');
          if (
            caller &&
            (caller.taskId !== next.taskId || caller.conversationId !== next.conversationId)
          )
            throw new Error('Only the designated main conversation can take over a task.');
          const task = await this.codeTask(taskId, records);
          if (!task || task.archivedAt)
            throw new Error('The target task is unavailable or archived.');
          if (task.type !== 'task' || records.some((entry) => entry.taskId === taskId))
            throw new Error('Main agents and automation runs cannot be taken over as code tasks.');
          await this.deps.assertProjectAvailable(task.projectId);
          const actor: AgentCaller = caller ?? {
            taskId: next.taskId,
            conversationId: next.conversationId,
            projectId: next.projectId,
            providerId: next.primary.agent ?? 'coordinator',
            title: next.name,
            cwd: null,
          };
          if (
            !mayAccessProject(
              actor,
              { kind: 'main', coordinator: next },
              task.projectId,
              'delegate'
            )
          )
            throw new Error(`Project permission denied: ${task.projectId}`);
          const owners = records.filter((entry) => entry.tasks[taskId]);
          if (owners.length > 1)
            throw new Error(
              'The task has multiple recorded owners. Resolve ownership before transferring it.'
            );
          const source = owners[0];
          if (source?.id === id) return next;
          if ((source?.id ?? null) !== expectedOwner || source?.id !== previous?.id)
            throw new Error('The task owner changed. Read its status before taking it over.');
          const assignment = source?.tasks[taskId] ?? {
            taskId,
            projectId: task.projectId,
            name: task.name,
            state: 'assigned' as const,
            resultVersion: 0,
            submissions: {},
          };
          next.tasks[taskId] = {
            ...assignment,
            projectId: task.projectId,
            name: task.name,
            grantedProjectIds: assignment.grantedProjectIds?.filter((projectId) =>
              mayAccessProject(actor, { kind: 'main', coordinator: next }, projectId, 'delegate')
            ),
            ownershipHistory: [
              ...(assignment.ownershipHistory ?? []),
              { from: source?.id ?? null, to: next.id, at: Date.now() },
            ],
          };
          if (source) {
            delete source.tasks[taskId];
            const moved = source.events.filter((event) => event.taskId === taskId);
            source.events = source.events.filter((event) => event.taskId !== taskId);
            next.events.push(
              ...moved.map((event) =>
                event.state === 'acknowledged'
                  ? event
                  : { ...event, state: 'pending' as const, error: undefined }
              )
            );
          }
          const changed = source ? [source, next] : [next];
          await this.deps.store.setManyOrThrow(
            changed.map((entry) => ({
              key: entry.id,
              value: coordinatorRecord.schema.parse(entry),
            }))
          );
          for (const entry of changed)
            this.deps.emit({
              coordinatorId: entry.id,
              projectId: entry.projectId,
              taskId: entry.taskId,
            });
          return next;
        })
      )
    );
    void this.deliverPending(id).catch((error) => this.deps.reportError?.(error, id));
    this.deps.onSchedulingChange?.();
    return record;
  }
  async inspectTask(id: string, taskId: string): Promise<TakeoverPreview> {
    const record = await this.get(id);
    const task = await this.codeTask(taskId, await this.list());
    if (!task || task.archivedAt || task.type !== 'task')
      throw new Error('Choose an available code task.');
    await this.deps.assertProjectAvailable(task.projectId);
    const caller: AgentCaller = {
      taskId: record.taskId,
      conversationId: record.conversationId,
      projectId: record.projectId,
      providerId: record.primary.agent ?? 'coordinator',
      title: record.name,
      cwd: null,
    };
    if (!mayAccessProject(caller, { kind: 'main', coordinator: record }, task.projectId, 'read'))
      throw new Error(`Project permission denied: ${task.projectId}`);
    const owner = (await this.list()).find((entry) => entry.tasks[taskId]);
    return {
      taskId,
      projectId: task.projectId,
      name: task.name,
      ownerId: owner?.id ?? null,
      ownerName: owner?.name ?? null,
    };
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
      if (!task) throw new Error('The task owner changed. Retry submitting the result.');
      if (task.taskCreated === false)
        throw new Error('The task has not been created. Wait for its prerequisites.');
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
      this.deps.onSchedulingChange?.();
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
            if (task.state === 'assigned' || task.state === 'blocked' || task.state === 'cancelled')
              continue;
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
  async resolveResultEventForUser(id: string, eventId: string): Promise<void> {
    await this.deliveries.runExclusive(id, () =>
      this.locks.runExclusive(id, async () => {
        const record = await this.get(id);
        const event = record.events.find((entry) => entry.id === eventId);
        if (!event) throw new Error('This result event is no longer assigned to this main agent.');
        if (event.state === 'acknowledged') return;
        event.state = 'acknowledged';
        event.error = undefined;
        await this.save(record);
      })
    );
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
            `Task "${record.tasks[event.taskId]?.name ?? event.taskId}" submitted a result (version ${event.version}): ${result.summary}`,
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
