import { createHash, randomUUID } from 'node:crypto';
import { KeyedMutex } from '@emdash/shared/concurrency';
import type { AgentCaller, AgentControlResult } from '@core/features/agent-control/api';
import type { TaskDelegationStatus } from '@core/features/agent-control/api/delegations';
import type { DelegationResources } from '@core/features/agent-control/api/node/delegation-resources';
import type { CreateTaskParams, Task } from '@core/primitives/tasks/api';
import {
  documentReferencesSchema,
  type ManagementDocumentReference,
  type ManagementDocument,
  type DocumentCommit,
  type DocumentWrite,
  documentMigrationInputSchema,
  type DocumentMigrationInput,
} from '../api/documents';
import {
  canTransitionOptimizationRun,
  requiresOptimizationConfirmation,
  type LivePromotion,
  type OptimizationRisk,
  type OptimizationRun,
  type OptimizationRunState,
  type OptimizationSuggestion,
} from '../api/optimization';
import {
  taskResultSchema,
  agentSelectionSchema,
  coordinatorRecord,
  getCoordinatorActionAvailability,
  type AgentSelection,
  type AssignedTask,
  type Coordinator,
  type CoordinationEvent,
  type TaskResult,
  type ResolvedAgentSelection,
  type ProjectAccess,
  type TakeoverPreview,
  type DocumentStorage,
  type WorkspaceLifecycle,
  type WorkspaceWorkItem,
  type WorkspaceProjectImport,
} from '../api/types';
import { coordinatorPrincipal, mayAccessProject, mayAccessTask } from './coordinator-access';
import type { CoordinatorDocuments } from './coordinator-documents';

type Dependencies = {
  delegations?: {
    status(taskId: string): Promise<TaskDelegationStatus | null>;
    retry(caller: AgentCaller, taskId: string): Promise<AgentControlResult>;
  };
  documents?: Pick<CoordinatorDocuments, 'describe' | 'create' | 'read'> &
    Partial<
      Pick<
        CoordinatorDocuments,
        | 'commit'
        | 'pushTargets'
        | 'pushTarget'
        | 'preparePush'
        | 'write'
        | 'readMigrationSource'
        | 'copyMigrationDocument'
      >
    >;
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
  ensureMainAgentHostProject?(): Promise<string>;
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

const instruction = `You are working in an app-level Emdash Main Agent workspace. Every conversation in this main-agent task has the same coordination permissions; the configured notification conversation only receives automatic result wake-ups.
Keep workspace work items separate from Project requirements: work items describe this workspace's outcomes and analysis, while requirements remain the Project backlog authority.
Before planning or updating a cross-project solution, call get_main_agent_context to read linked-project requirements, project decisions and global memory together.
Coordinate existing Emdash tasks through MCP.
Delegate implementation into task worktrees; keep code changes on their own branches.
Specify a stable request_id when creating a task and reuse it for retries. You may select agent, supplier_id, model and effort. Use depends_on for tasks that must wait for approved prerequisite results. Attach only relevant management documents with document_refs; their versions and content are frozen for that task.
If a saved task fails to start, inspect get_task_status and use retry_task with its task ID after fixing the failure. This also works after a receiver switch or explicit task takeover; do not create a replacement task to recover startup.
Use create_pull_request with the assigned task ID and a stable request_id to push its code branch and open a PR. Specify the push remote and target repository/branch when project defaults are insufficient. Inspect get_task_status.pullRequests and use retry_pull_request to resume a saved request without changing its frozen source or target.
Workers must call submit_task_result with commits, checks and unresolved issues. Inspect their changes and evidence before reviewing a result.
When a result notification arrives, call acknowledge_task_results with its event IDs before taking follow-up actions.
Agent startup, an idle process and a created PR do not prove task completion. Do not automatically merge branches or PRs.`;

function optimizationWorkItemState(state: OptimizationRunState): WorkspaceWorkItem['state'] {
  if (state === 'accepted') return 'done';
  if (['waiting_for_approval', 'blocked', 'failed'].includes(state)) return 'waiting';
  if (['ready_to_apply', 'observing', 'rolled_back'].includes(state)) return 'review';
  if (state === 'captured') return 'open';
  return 'in_progress';
}

export class CoordinatorService {
  private readonly locks = new KeyedMutex();
  private readonly deliveries = new KeyedMutex();
  private readonly ownership = new KeyedMutex();
  constructor(private readonly deps: Dependencies) {}
  async list(options: { includeDeleted?: boolean } = {}): Promise<Coordinator[]> {
    const records: Coordinator[] = [];
    for (const [id, value] of Object.entries(await this.deps.store.getAll())) {
      if (!value) continue;
      try {
        const record = this.parseRecord(value);
        if (options.includeDeleted || !record.deletedAt) records.push(record);
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
        version: '12',
        id,
        kind: 'project',
        name: '主任务',
        projectId,
        projectIds: [projectId],
        taskId: randomUUID(),
        conversationId: randomUUID(),
        primary: { agent: await this.deps.defaultAgent() },
        delegationDefaults: {},
        tasks: {},
        events: [],
        purpose: '',
        lifecycle: { kind: 'ongoing', state: 'active' },
        workItems: {},
        checkpoints: [],
        optimizationRuns: {},
        optimizationSuggestions: {},
        livePromotions: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.save(record);
      return record;
    });
  }
  async createCrossProject(input: {
    id: string;
    name: string;
    projectId?: string;
    projectIds: string[];
    primary?: AgentSelection;
    delegationDefaults?: AgentSelection;
    purpose?: string;
    lifecycle?: WorkspaceLifecycle;
  }): Promise<Coordinator> {
    const id = `cross:${input.id}`;
    const name = input.name.trim();
    if (!name) throw new Error('Name the cross-project main agent.');
    const projectId = input.projectId ?? (await this.deps.ensureMainAgentHostProject?.());
    if (!projectId) throw new Error('The main-agent management repository is unavailable.');
    const projectIds = [...new Set(input.projectIds)].sort();
    const primary = agentSelectionSchema.parse(input.primary ?? {});
    const delegationDefaults = agentSelectionSchema.parse(input.delegationDefaults ?? {});
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          name,
          projectId,
          projectIds,
          primary,
          delegationDefaults,
          purpose: input.purpose?.trim() ?? '',
          lifecycle: input.lifecycle ?? { kind: 'finite', state: 'active' },
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
      await this.deps.assertProjectAvailable(projectId);
      for (const projectId of projectIds) await this.deps.assertProjectAvailable(projectId);
      for (const selection of [primary, delegationDefaults]) {
        const resolved = await this.deps.resolveSelection(selection);
        if (resolved.errors.length) throw new Error(resolved.errors.join(' '));
      }
      const record: Coordinator = {
        version: '12',
        id,
        name,
        kind: 'cross-project',
        projectId,
        projectIds,
        taskId: randomUUID(),
        conversationId: randomUUID(),
        primary: { agent: await this.deps.defaultAgent(), ...primary },
        delegationDefaults,
        tasks: {},
        events: [],
        creationFingerprint: fingerprint,
        purpose: input.purpose?.trim() ?? '',
        lifecycle: input.lifecycle ?? { kind: 'finite', state: 'active' },
        workItems: {},
        checkpoints: [],
        optimizationRuns: {},
        optimizationSuggestions: {},
        livePromotions: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.save(record);
      return record;
    });
  }
  async migrateToStandalone(id: string, requestId: string): Promise<Coordinator> {
    const destinationId = `cross:${requestId}`;
    const hostProjectId = await this.deps.ensureMainAgentHostProject?.();
    if (!hostProjectId) throw new Error('The main-agent management repository is unavailable.');
    return this.underLocks(this.locks, [id, destinationId], async () => {
      const source = await this.get(id);
      if (source.projectId === hostProjectId) return source;
      const existing = await this.deps.store.getOrThrow(destinationId);
      if (existing) {
        const parsed = this.parseRecord(existing);
        if (parsed.migratedFromId !== source.id)
          throw new Error('This migration request_id was already used for another workspace.');
        return parsed;
      }
      const now = Date.now();
      const destination: Coordinator = {
        ...source,
        id: destinationId,
        kind: 'cross-project',
        projectId: hostProjectId,
        projectIds: [...new Set([...source.projectIds, source.projectId])],
        taskId: randomUUID(),
        conversationId: randomUUID(),
        params: undefined,
        tasks: {},
        events: [],
        creationFingerprint: createHash('sha256')
          .update(JSON.stringify({ migratedFromId: source.id, requestId }))
          .digest('hex'),
        migratedFromId: source.id,
        supersededById: undefined,
        documentStorage: undefined,
        documentMigration: undefined,
        documentStorageHistory: source.documentStorage
          ? [...(source.documentStorageHistory ?? []), source.documentStorage]
          : source.documentStorageHistory,
        createdAt: now,
        updatedAt: now,
      };
      if (source.lifecycle.kind === 'finite') {
        if (source.lifecycle.state !== 'archived') {
          source.lifecycle.archivedFrom = source.lifecycle.state;
          source.lifecycle.state = 'archived';
        }
      } else if (source.lifecycle.state !== 'archived') {
        source.lifecycle.archivedFrom = source.lifecycle.state;
        source.lifecycle.state = 'archived';
      }
      source.supersededById = destination.id;
      source.updatedAt = now;
      await this.deps.store.setManyOrThrow([
        { key: source.id, value: coordinatorRecord.schema.parse(source) },
        { key: destination.id, value: coordinatorRecord.schema.parse(destination) },
      ]);
      this.deps.emit({
        coordinatorId: source.id,
        projectId: source.projectId,
        taskId: source.taskId,
      });
      this.deps.emit({
        coordinatorId: destination.id,
        projectId: destination.projectId,
        taskId: destination.taskId,
      });
      return destination;
    });
  }
  async rollbackStandaloneMigration(id: string): Promise<Coordinator> {
    const destination = await this.get(id);
    if (!destination.migratedFromId)
      throw new Error('This workspace was not created by migration.');
    return this.underLocks(this.locks, [id, destination.migratedFromId], async () => {
      const latest = await this.get(id);
      const source = await this.get(latest.migratedFromId!);
      if (source.supersededById !== latest.id)
        throw new Error('The migration relationship changed and cannot be rolled back.');
      const now = Date.now();
      if (source.lifecycle.kind === 'finite') {
        source.lifecycle.state = source.lifecycle.archivedFrom ?? 'active';
        source.lifecycle.archivedFrom = undefined;
      } else {
        source.lifecycle.state = source.lifecycle.archivedFrom ?? 'active';
        source.lifecycle.archivedFrom = undefined;
      }
      source.supersededById = undefined;
      latest.lifecycle.archivedFrom =
        latest.lifecycle.state === 'archived' ? undefined : latest.lifecycle.state;
      latest.lifecycle.state = 'archived';
      source.updatedAt = now;
      latest.updatedAt = now;
      await this.deps.store.setManyOrThrow([
        { key: source.id, value: coordinatorRecord.schema.parse(source) },
        { key: latest.id, value: coordinatorRecord.schema.parse(latest) },
      ]);
      this.deps.emit({
        coordinatorId: source.id,
        projectId: source.projectId,
        taskId: source.taskId,
      });
      this.deps.emit({
        coordinatorId: latest.id,
        projectId: latest.projectId,
        taskId: latest.taskId,
      });
      return source;
    });
  }
  async prepareProjectImport(
    id: string,
    input: Pick<WorkspaceProjectImport, 'requestId' | 'repositoryUrl' | 'name' | 'directory'>
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const existing = record.projectImports?.[input.requestId];
      if (existing) {
        if (
          existing.repositoryUrl !== input.repositoryUrl ||
          existing.name !== input.name ||
          existing.directory !== input.directory
        )
          throw new Error('This import request_id was already used with different parameters.');
        if (existing.state === 'ready') return record;
      }
      const now = Date.now();
      record.projectImports ??= {};
      record.projectImports[input.requestId] = {
        ...input,
        state: 'cloning',
        progress: 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.save(record);
      return record;
    });
  }
  async updateProjectImport(
    id: string,
    requestId: string,
    patch: Pick<WorkspaceProjectImport, 'state'> &
      Partial<Pick<WorkspaceProjectImport, 'progress' | 'projectId' | 'error'>>
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const current = record.projectImports?.[requestId];
      if (!current) throw new Error('The project import no longer exists.');
      if (
        ['cancelled', 'ready'].includes(current.state) &&
        ['cloning', 'registering'].includes(patch.state)
      )
        return record;
      record.projectImports![requestId] = {
        ...current,
        ...patch,
        error: patch.error,
        updatedAt: Date.now(),
      };
      await this.save(record);
      return record;
    });
  }
  async getByTask(taskId: string): Promise<Coordinator | null> {
    return (await this.list()).find((record) => record.taskId === taskId) ?? null;
  }
  async notifyTaskChanged(taskId: string): Promise<void> {
    const owner = (await this.list()).find((record) => record.tasks[taskId]);
    if (owner)
      this.deps.emit({
        coordinatorId: owner.id,
        projectId: owner.projectId,
        taskId: owner.taskId,
      });
  }
  async documentStorageReferences(projectId: string) {
    const records = Object.values(await this.deps.store.getAll())
      .filter(Boolean)
      .map((value) => this.parseRecord(value));
    return records
      .filter((record) => {
        const migration = record.documentMigration;
        const pending =
          migration &&
          !['complete', 'cancelled'].includes(migration.phase) &&
          (migration.source.projectId === projectId || migration.target.projectId === projectId);
        return (
          pending ||
          (record.projectId !== projectId && record.documentStorage?.projectId === projectId)
        );
      })
      .map((record) => ({
        coordinatorId: record.id,
        projectId: record.projectId,
        name: record.name,
      }));
  }
  async delegationStatus(id: string, taskId: string) {
    const record = await this.get(id);
    if (!record.tasks[taskId]) throw new Error('This main agent does not own the task.');
    return (await this.deps.delegations?.status(taskId)) ?? null;
  }
  async retryTask(id: string, taskId: string): Promise<void> {
    const record = await this.get(id);
    const assignment = record.tasks[taskId];
    if (!assignment) throw new Error('This main agent does not own the task.');
    if (assignment.state === 'cancelled') throw new Error('The task was cancelled.');
    if (!this.deps.delegations) throw new Error('Task delegation is unavailable.');
    const conversation = await this.deps.getConversation(record.conversationId);
    if (
      conversation?.taskId !== record.taskId ||
      conversation.projectId !== record.projectId ||
      !conversation.selection.agent
    )
      throw new Error('The responsible main conversation is unavailable.');
    await this.deps.delegations.retry(
      {
        taskId: record.taskId,
        conversationId: record.conversationId,
        projectId: record.projectId,
        providerId: conversation.selection.agent,
        title: record.name,
        cwd: null,
      },
      taskId
    );
  }
  async instructionsForTask(taskId: string): Promise<string | undefined> {
    const records = await this.list();
    const main = records.find((record) => record.taskId === taskId);
    if (main)
      return `${instruction}
Management document push target: ${JSON.stringify(main.documentPushTarget ?? null)}.
Management document storage: ${JSON.stringify(main.documentStorage ? { projectId: main.documentStorage.projectId, taskId: main.documentStorage.taskId, state: main.documentStorage.state } : null)}. Use read_management_document and write_management_document to access the configured storage; it may be outside your conversation's working directory. Updating a file requires the returned disk version as expected_revision. Creating or editing a document does not commit or push it.
Keep management documents local until a personal fork is explicitly configured. A saved target does not trigger a push. When a push is requested, check get_task_status for this main task to obtain its current documentPushTarget; never substitute a default code remote or push code baseline refs.`;
    const assignment = records.find((record) => record.tasks[taskId])?.tasks[taskId];
    if (assignment)
      return `You are executing delegated Emdash task ${taskId}.
Keep code on this task's branch. Before finishing, call submit_task_result with this task ID,
a stable request_id, a summary, commit references, checks actually run and unresolved issues.
Do not mark the task complete yourself. The responsible main agent reviews your result.
Approved prerequisite versions: ${JSON.stringify(assignment.dependencyResults ?? [])}. These references do not install changes into this repository; consume the specified commits or versions explicitly.
Frozen management documents: ${JSON.stringify(assignment.documents ?? [])}. Use these saved versions as task context. They grant access only to these snapshots, not to the rest of the source management workspace. Read a snapshot through read_management_document with its coordinatorId, path and revision.`;
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
    record.updatedAt = Date.now();
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
      if (record.deletedAt) throw new Error('Restore this workspace from Trash before opening it.');
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
        if (params.workspaceConfig.git.kind === 'none') {
          if (params.workspaceConfig.workspace.kind !== 'repository-instance')
            throw new Error('A directory main agent needs its project workspace.');
        } else {
          if (params.workspaceConfig.workspace.kind !== 'new-worktree')
            throw new Error('A Git main agent needs an isolated management workspace.');
          params.workspaceConfig.git = {
            kind: 'management',
            branchName: `emdash/manage/${record.taskId}`,
          };
        }
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
  private documentService() {
    if (!this.deps.documents) throw new Error('Management documents are unavailable.');
    return this.deps.documents;
  }
  private async documentRecord(id: string) {
    const saved = await this.get(id);
    await this.assertDocumentAvailable(saved);
    return saved.params ? saved : this.open(id);
  }
  private async assertDocumentAvailable(saved: Coordinator) {
    await this.deps.assertProjectAvailable(saved.projectId);
    if (saved.documentStorage) {
      await this.deps.assertProjectAvailable(saved.documentStorage.projectId);
      if (saved.documentStorage.state !== 'ready')
        throw new Error(
          'Document storage setup is incomplete. Retry setup using the saved project.'
        );
      const state = await this.deps
        .resources()
        .findTask(saved.documentStorage.taskId, saved.documentStorage.projectId);
      if (state !== 'available')
        throw new Error('The saved document workspace is unavailable. Its binding is preserved.');
    }
  }
  async createDocumentStorage(id: string, projectId: string): Promise<Coordinator> {
    if (!(await this.get(id)).params) await this.open(id);
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      await this.deps.assertProjectAvailable(record.projectId);
      await this.deps.assertProjectAvailable(projectId);
      const runtime = this.deps.resources();
      if (
        record.documentMigration &&
        !['complete', 'cancelled'].includes(record.documentMigration.phase)
      )
        throw new Error(
          'Finish or cancel the pending document migration before setting up storage.'
        );
      let storage = record.documentStorage;
      if (storage && storage.projectId !== projectId)
        throw new Error('Use document migration to change the saved storage project.');
      if (!storage) {
        if (record.params?.workspaceConfig.git.kind !== 'none')
          throw new Error('Use document migration to preserve the documents in this workspace.');
        storage = await this.prepareDocumentTarget(record, projectId);
        record.documentStorage = storage;
        await this.save(record);
      }
      const state = await runtime.findTask(storage.taskId, storage.projectId);
      if (state === 'deleted')
        throw new Error(
          'The document storage task was removed or archived. Its binding is preserved.'
        );
      if (state === 'missing') await runtime.create(storage.params);
      await runtime.activate(storage.taskId, storage.projectId);
      if (storage.state !== 'ready') {
        storage.state = 'ready';
        record.projectIds = [...new Set([...record.projectIds, storage.projectId])];
        await this.save(record);
      }
      return record;
    });
  }
  async cancelDocumentStorageSetup(id: string, taskId: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      await this.deps.assertProjectAvailable(record.projectId);
      const storage = record.documentStorage;
      if (!storage) return record;
      if (storage.taskId !== taskId)
        throw new Error('The document storage setup changed. Refresh before cancelling.');
      if (storage.state !== 'preparing')
        throw new Error('Use document migration to preserve the saved documents.');
      record.documentStorageHistory = [...(record.documentStorageHistory ?? []), storage];
      record.documentStorage = undefined;
      record.documentPushTarget = undefined;
      await this.save(record);
      return record;
    });
  }
  private async prepareDocumentTarget(
    record: Coordinator,
    projectId: string
  ): Promise<DocumentStorage> {
    const taskId = randomUUID();
    const params = await this.deps.resources().prepare(
      {
        taskId: record.taskId,
        conversationId: record.conversationId,
        projectId: record.projectId,
        providerId: record.primary.agent ?? (await this.deps.defaultAgent()),
        title: record.name,
        cwd: null,
      },
      { kind: 'create_task', projectId, name: `${record.name} documents` },
      { taskId, conversationId: randomUUID(), role: 'coordination' }
    );
    if (
      params.workspaceConfig.git.kind !== 'management' ||
      params.workspaceConfig.workspace.kind !== 'new-worktree'
    )
      throw new Error('Choose a Git repository for management document storage.');
    params.taskConfig.role = 'coordination';
    params.taskConfig.initialConversation = undefined;
    return { projectId, taskId, params, state: 'preparing' };
  }
  async prepareDocumentMigration(id: string, input: DocumentMigrationInput): Promise<Coordinator> {
    const selected = documentMigrationInputSchema.parse(input);
    if (!(await this.get(id)).params) await this.open(id);
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      await this.deps.assertProjectAvailable(record.projectId);
      await this.deps.assertProjectAvailable(selected.projectId);
      const paths = [...new Set(selected.paths)].sort();
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([selected.projectId, paths]))
        .digest('hex');
      if (record.documentMigration?.id === selected.requestId) {
        if (record.documentMigration.fingerprint !== fingerprint)
          throw new Error('This migration request has different parameters.');
        return record;
      }
      if (
        record.documentMigration &&
        !['complete', 'cancelled'].includes(record.documentMigration.phase)
      )
        throw new Error('Finish or cancel the pending document migration first.');
      if (!record.params) throw new Error('The main agent workspace is unavailable.');
      const source = record.documentStorage ?? {
        projectId: record.projectId,
        taskId: record.taskId,
        params: record.params,
        state: 'ready' as const,
      };
      if (source.state !== 'ready')
        throw new Error('Finish the saved document storage setup first.');
      const documents = this.documentService();
      if (!documents.readMigrationSource) throw new Error('Document migration is unavailable.');
      const files: ManagementDocument[] = [];
      for (const path of paths)
        files.push(await documents.readMigrationSource(record, source, path));
      if (
        files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content, 'utf8'), 0) >
        16 * 1024 * 1024
      )
        throw new Error('Choose management documents totaling no more than 16 MiB per migration.');
      const target = await this.prepareDocumentTarget(record, selected.projectId);
      record.documentMigration = {
        id: selected.requestId,
        fingerprint,
        source,
        target,
        files,
        copied: [],
        phase: 'prepared',
      };
      await this.save(record);
      return record;
    });
  }
  async runDocumentMigration(id: string, migrationId: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const migration = record.documentMigration;
      if (!migration || migration.id !== migrationId)
        throw new Error('The document migration changed. Refresh before continuing.');
      if (migration.phase === 'complete') return record;
      if (migration.phase === 'cancelled')
        throw new Error('This document migration was cancelled.');
      const documents = this.documentService();
      if (!documents.readMigrationSource || !documents.copyMigrationDocument)
        throw new Error('Document migration is unavailable.');
      const readSource = documents.readMigrationSource.bind(documents);
      const copy = documents.copyMigrationDocument.bind(documents);
      const verifySource = async () => {
        for (const file of migration.files) {
          const actual = await readSource(record, migration.source, file.path);
          if (
            actual.workspaceId !== file.workspaceId ||
            actual.revision !== file.revision ||
            actual.content !== file.content
          )
            throw new Error(
              `Source document changed: ${file.path}. Cancel this plan and prepare a migration from the saved source.`
            );
        }
      };
      try {
        await this.deps.assertProjectAvailable(record.projectId);
        await this.deps.assertProjectAvailable(migration.target.projectId);
        await verifySource();
        const runtime = this.deps.resources();
        const state = await runtime.findTask(migration.target.taskId, migration.target.projectId);
        if (state === 'deleted')
          throw new Error('The migration destination was removed. Original storage is preserved.');
        if (state === 'missing') await runtime.create(migration.target.params);
        await runtime.activate(migration.target.taskId, migration.target.projectId);
        migration.target.state = 'ready';
        migration.phase = 'copying';
        migration.error = undefined;
        await this.save(record);
        for (const file of migration.files) {
          const copied = await copy(record, migration.target, file);
          if (copied.content !== file.content)
            throw new Error(`Document copy verification failed: ${file.path}`);
          migration.copied = [
            ...migration.copied.filter((entry) => entry.path !== file.path),
            { path: file.path, revision: copied.revision },
          ];
          await this.save(record);
        }
        await verifySource();
        for (const file of migration.files) {
          const revision = migration.copied.find((entry) => entry.path === file.path)?.revision;
          if (!revision) throw new Error(`Missing copied document version: ${file.path}`);
          const copied = await documents.read(
            { ...record, documentStorage: migration.target },
            file.path,
            revision
          );
          if (copied.content !== file.content)
            throw new Error(`Document verification failed: ${file.path}`);
        }
        migration.phase = 'verified';
        await this.save(record);
        record.documentStorageHistory = [
          ...(record.documentStorageHistory ?? []).filter(
            (entry) => entry.taskId !== migration.source.taskId
          ),
          migration.source,
        ];
        record.documentStorage = migration.target;
        record.documentPushTarget = undefined;
        record.projectIds = [...new Set([...record.projectIds, migration.target.projectId])];
        migration.phase = 'complete';
        await this.save(record);
        return record;
      } catch (error) {
        const persisted = await this.get(id);
        if (persisted.documentMigration?.id === migrationId) {
          persisted.documentMigration.error =
            error instanceof Error ? error.message : String(error);
          await this.save(persisted);
        }
        throw error;
      }
    });
  }
  async cancelDocumentMigration(id: string, migrationId: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const migration = record.documentMigration;
      if (!migration || migration.id !== migrationId)
        throw new Error('The document migration changed. Refresh before cancelling.');
      if (migration.phase === 'complete')
        throw new Error(
          'The migration is complete. Prepare another migration to move documents again.'
        );
      if (migration.phase === 'cancelled') return record;
      record.documentStorageHistory = [...(record.documentStorageHistory ?? []), migration.target];
      migration.phase = 'cancelled';
      await this.save(record);
      return record;
    });
  }
  async documentWorkspace(id: string) {
    return this.documentService().describe(await this.documentRecord(id));
  }
  async createDocument(id: string, path: string) {
    return this.documentService().create(await this.documentRecord(id), path);
  }
  async writeDocument(id: string, input: DocumentWrite, caller?: AgentCaller) {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      await this.assertDocumentAvailable(record);
      if (caller && caller.taskId !== record.taskId)
        throw new Error('Only a conversation in this main agent can write management documents.');
      const documents = this.documentService();
      if (!documents.write) throw new Error('Management document writes are unavailable.');
      const result = await documents.write(record, input);
      this.deps.emit({
        coordinatorId: record.id,
        projectId: record.projectId,
        taskId: record.taskId,
      });
      return result;
    });
  }
  async documentPushOptions(id: string) {
    const documents = this.documentService();
    if (!documents.pushTargets)
      throw new Error('Management document push configuration is unavailable.');
    return documents.pushTargets(await this.documentRecord(id));
  }
  async configureDocumentPush(id: string, remote: string | null, expectedFingerprint?: string) {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      await this.deps.assertProjectAvailable(record.projectId);
      if (remote === null) record.documentPushTarget = undefined;
      else {
        await this.assertDocumentAvailable(record);
        const documents = this.documentService();
        if (!documents.pushTarget)
          throw new Error('Management document push configuration is unavailable.');
        const target = await documents.pushTarget(record, remote);
        if (target.fingerprint !== expectedFingerprint)
          throw new Error(
            'The document destination changed. Refresh the remote list before saving.'
          );
        record.documentPushTarget = target;
      }
      await this.save(record);
      return record;
    });
  }
  async prepareDocumentPush(id: string, expectedRevision: string, expectedFingerprint: string) {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      await this.assertDocumentAvailable(record);
      const documents = this.documentService();
      if (!documents.preparePush) throw new Error('Management document push is unavailable.');
      if (record.documentPushTarget?.fingerprint !== expectedFingerprint)
        throw new Error(
          'The document push target changed. Review the saved remote before pushing.'
        );
      return documents.preparePush(record, expectedRevision);
    });
  }
  async commitDocuments(id: string, input: DocumentCommit) {
    return this.locks.runExclusive(id, async () => {
      const documents = this.documentService();
      if (!documents.commit) throw new Error('Management document commits are unavailable.');
      const record = await this.get(id);
      await this.assertDocumentAvailable(record);
      if (!record.params)
        throw new Error('Open the main agent document workspace before committing.');
      return documents.commit(record, input);
    });
  }
  async readDocument(id: string, path: string, revision?: string, caller?: AgentCaller) {
    if (caller) {
      const records = await this.accessRecords(caller);
      const principal = coordinatorPrincipal(caller, records);
      if (principal.kind === 'worker') {
        const snapshots = (principal.assignment.documents ?? []).filter(
          (doc) =>
            doc.coordinatorId === id &&
            doc.path === path &&
            (!revision || doc.revision === revision)
        );
        if (snapshots.length > 1)
          throw new Error('Choose the explicit version of this task document.');
        if (snapshots.length === 1) return snapshots[0];
      }
    }
    const documents = this.documentService();
    const record = await this.get(id);
    if (
      caller &&
      !(await this.mayAccessTask(
        caller,
        { id: record.taskId, projectId: record.projectId },
        'read'
      ))
    )
      throw new Error('Management document permission denied.');
    await this.deps.assertProjectAvailable(record.projectId);
    // Reading cannot allocate or start a main agent on behalf of a worker.
    return documents.read(record, path, revision);
  }
  async update(
    id: string,
    patch: {
      name?: string;
      primary?: AgentSelection;
      delegationDefaults?: AgentSelection;
      projectAccess?: ProjectAccess;
      projectIds?: string[];
    }
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (record.deletedAt) throw new Error('Restore this workspace from Trash before editing it.');
      const name = patch.name?.trim();
      if (patch.name !== undefined && !name) throw new Error('Name the main agent workspace.');
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
      const next = { ...record, ...patch, ...(name && { name }) };
      await this.save(next);
      if (patch.projectAccess) this.deps.onSchedulingChange?.();
      return next;
    });
  }

  async addWorkItem(
    id: string,
    input: Pick<WorkspaceWorkItem, 'title' | 'detail'> &
      Partial<Pick<WorkspaceWorkItem, 'kind' | 'origin'>> & { requestId: string }
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const title = input.title.trim();
      const detail = input.detail?.trim() || undefined;
      const existing = record.workItems[input.requestId];
      if (existing) {
        if (existing.title !== title || existing.detail !== detail)
          throw new Error('This work item request has different content.');
        return record;
      }
      const now = Date.now();
      record.workItems[input.requestId] = {
        id: input.requestId,
        kind: input.kind ?? 'delivery',
        origin: input.origin ?? { kind: 'user' },
        title,
        ...(detail && { detail }),
        state: 'open',
        taskIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.save(record);
      return record;
    });
  }

  async createOptimizationRun(
    id: string,
    input: {
      requestId: string;
      conversationId: string;
      suggestionId?: string;
      executionMode: OptimizationRun['executionMode'];
      experienceConfirmation: OptimizationRun['experienceConfirmation'];
      objective: string;
      observedProblem: string;
      capturedContext: OptimizationRun['capturedContext'];
      baseline: OptimizationRun['baseline'];
      risk: OptimizationRisk;
    }
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const existing = record.optimizationRuns[input.requestId];
      if (existing) {
        if (
          existing.objective !== input.objective.trim() ||
          existing.observedProblem !== input.observedProblem.trim()
        )
          throw new Error('This optimization request has different content.');
        return record;
      }
      if (input.suggestionId && !record.optimizationSuggestions[input.suggestionId])
        throw new Error('The optimization suggestion no longer exists.');
      const now = Date.now();
      const workItemId = randomUUID();
      record.workItems[workItemId] = {
        id: workItemId,
        kind: 'experience-improvement',
        origin: input.suggestionId
          ? { kind: 'accepted-suggestion', suggestionId: input.suggestionId }
          : { kind: 'agent', conversationId: input.conversationId },
        title: input.objective.trim().slice(0, 200),
        detail: input.observedProblem.trim(),
        state: 'open',
        taskIds: [],
        createdAt: now,
        updatedAt: now,
      };
      const requiresApproval =
        input.executionMode === 'proposal-first' || requiresOptimizationConfirmation(input.risk);
      record.optimizationRuns[input.requestId] = {
        id: input.requestId,
        workItemId,
        trigger: input.suggestionId
          ? {
              kind: 'accepted-suggestion',
              suggestionId: input.suggestionId,
              conversationId: input.conversationId,
            }
          : { kind: 'manual', conversationId: input.conversationId },
        executionMode: input.executionMode,
        experienceConfirmation: input.experienceConfirmation,
        objective: input.objective.trim(),
        observedProblem: input.observedProblem.trim(),
        capturedContext: input.capturedContext,
        baseline: input.baseline,
        risk: input.risk,
        state: 'captured',
        taskIds: [],
        acceptedResultVersions: [],
        stateHistory: [
          {
            state: 'captured',
            at: now,
            ...(requiresApproval && { reason: '实施前需要确认方案或高风险操作。' }),
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      if (input.suggestionId) {
        const suggestion = record.optimizationSuggestions[input.suggestionId]!;
        suggestion.state = 'accepted';
        suggestion.workItemId = workItemId;
        suggestion.runId = input.requestId;
        suggestion.updatedAt = now;
      }
      await this.save(record);
      return record;
    });
  }

  async transitionOptimizationRun(
    id: string,
    runId: string,
    input: {
      state: OptimizationRunState;
      reason?: string;
      risk?: OptimizationRisk;
      technicalValidationPassed?: boolean;
      userDecision?: 'pending' | 'accepted' | 'continue' | 'rollback';
      note?: string;
    }
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const run = record.optimizationRuns[runId];
      if (!run) throw new Error('The optimization run no longer exists.');
      const nextRisk = input.risk ?? run.risk;
      if (input.risk) run.risk = input.risk;
      if (run.state === input.state) return record;
      if (!canTransitionOptimizationRun(run.state, input.state))
        throw new Error(`Cannot move an optimization from ${run.state} to ${input.state}.`);
      if (
        ['implementing', 'applying'].includes(input.state) &&
        requiresOptimizationConfirmation(nextRisk) &&
        run.state !== 'waiting_for_approval'
      )
        throw new Error('High-risk optimization requires explicit approval before implementation.');
      if (input.state === 'ready_to_apply' && input.technicalValidationPassed !== true)
        throw new Error('Technical validation must pass before an optimization can be applied.');
      const now = Date.now();
      run.state = input.state;
      run.updatedAt = now;
      run.stateHistory.push({
        state: input.state,
        at: now,
        ...(input.reason?.trim() && { reason: input.reason.trim() }),
      });
      if (
        input.technicalValidationPassed !== undefined ||
        input.userDecision !== undefined ||
        input.note !== undefined
      ) {
        run.observation = {
          technicalValidationPassed:
            input.technicalValidationPassed ?? run.observation?.technicalValidationPassed ?? false,
          userDecision: input.userDecision ?? run.observation?.userDecision ?? 'pending',
          ...(input.note?.trim() && { note: input.note.trim() }),
          updatedAt: now,
        };
      }
      const item = record.workItems[run.workItemId];
      if (item) {
        item.state = optimizationWorkItemState(input.state);
        item.updatedAt = now;
        item.resolvedAt = input.state === 'accepted' ? now : undefined;
      }
      await this.save(record);
      return record;
    });
  }

  async addOptimizationSuggestion(
    id: string,
    input: Omit<
      OptimizationSuggestion,
      'id' | 'state' | 'workItemId' | 'runId' | 'createdAt' | 'updatedAt'
    > & { requestId: string }
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const duplicate = Object.values(record.optimizationSuggestions).find(
        (suggestion) => suggestion.fingerprint === input.fingerprint && suggestion.state === 'new'
      );
      if (duplicate) return record;
      const now = Date.now();
      record.optimizationSuggestions[input.requestId] = {
        id: input.requestId,
        fingerprint: input.fingerprint,
        title: input.title.trim(),
        observedPattern: input.observedPattern.trim(),
        proposedOutcome: input.proposedOutcome.trim(),
        evidenceRefs: [...input.evidenceRefs],
        confidence: input.confidence,
        state: 'new',
        createdAt: now,
        updatedAt: now,
      };
      await this.save(record);
      return record;
    });
  }

  async updateOptimizationSuggestion(
    id: string,
    suggestionId: string,
    state: 'dismissed' | 'expired'
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const suggestion = record.optimizationSuggestions[suggestionId];
      if (!suggestion) throw new Error('The optimization suggestion no longer exists.');
      if (suggestion.state === 'accepted')
        throw new Error('An accepted optimization suggestion cannot be dismissed.');
      suggestion.state = state;
      suggestion.updatedAt = Date.now();
      await this.save(record);
      return record;
    });
  }

  async recordLivePromotion(
    id: string,
    input: Omit<LivePromotion, 'createdAt' | 'updatedAt'>
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const existing = record.livePromotions[input.id];
      if (existing && existing.toRevision !== input.toRevision)
        throw new Error('This live promotion request has different content.');
      if (input.state === 'healthy' && input.commits.length === 0)
        throw new Error('A healthy live revision must be backed by accepted commits.');
      if (['dependency', 'data-migration'].includes(input.changeClass) && !input.backupSetId)
        throw new Error('Dependency and data changes require a backup set before promotion.');
      if (input.optimizationRunId) {
        const run = record.optimizationRuns[input.optimizationRunId];
        if (!run) throw new Error('The optimization run no longer exists.');
        run.promotionId = input.id;
        run.updatedAt = Date.now();
      }
      const now = Date.now();
      record.livePromotions[input.id] = {
        ...input,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.save(record);
      return record;
    });
  }

  async updateWorkItem(
    id: string,
    workItemId: string,
    patch: Pick<WorkspaceWorkItem, 'state'> & Partial<Pick<WorkspaceWorkItem, 'title' | 'detail'>>
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const item = record.workItems[workItemId];
      if (!item) throw new Error('The work item no longer exists.');
      item.title = patch.title?.trim() || item.title;
      if ('detail' in patch) item.detail = patch.detail?.trim() || undefined;
      item.state = patch.state;
      item.updatedAt = Date.now();
      item.resolvedAt = ['done', 'deferred', 'cancelled'].includes(item.state)
        ? Date.now()
        : undefined;
      await this.save(record);
      return record;
    });
  }

  async checkpoint(id: string, requestId: string, title: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (record.lifecycle.kind !== 'ongoing')
        throw new Error('Only an ongoing main agent can create checkpoints.');
      const existing = record.checkpoints.find((checkpoint) => checkpoint.id === requestId);
      if (existing) {
        if (existing.title !== title.trim())
          throw new Error('Checkpoint request_id was already used with a different title.');
        return record;
      }
      const now = Date.now();
      record.checkpoints.push({
        id: requestId,
        title: title.trim(),
        workItemIds: Object.keys(record.workItems),
        createdAt: now,
      });
      record.lifecycle.lastCheckpointAt = now;
      await this.save(record);
      return record;
    });
  }

  async setLifecycleState(
    id: string,
    action: 'complete' | 'pause' | 'resume' | 'archive' | 'restore',
    note?: string
  ): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (record.deletedAt) throw new Error('Restore this workspace from Trash first.');
      if (action === 'complete') {
        this.completeFinite(record, note);
      } else if (action === 'pause' || action === 'resume') {
        if (record.lifecycle.kind !== 'ongoing')
          throw new Error('Only an ongoing main agent can be paused or resumed.');
        record.lifecycle.state = action === 'pause' ? 'paused' : 'active';
      } else if (action === 'archive') {
        if (record.lifecycle.state !== 'archived')
          record.lifecycle.archivedFrom = record.lifecycle.state;
        record.lifecycle.state = 'archived';
      } else {
        if (record.lifecycle.state !== 'archived') return record;
        if (record.lifecycle.kind === 'finite') {
          record.lifecycle.state = record.lifecycle.archivedFrom ?? 'active';
          record.lifecycle.archivedFrom = undefined;
        } else {
          record.lifecycle.state = record.lifecycle.archivedFrom ?? 'active';
          record.lifecycle.archivedFrom = undefined;
        }
      }
      await this.save(record);
      return record;
    });
  }
  async completeAndArchive(id: string, note?: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      const availability = getCoordinatorActionAvailability(record).completeAndArchive;
      if (!availability.available) throw new Error(availability.reason);
      this.completeFinite(record, note);
      record.lifecycle.archivedFrom = 'completed';
      record.lifecycle.state = 'archived';
      await this.save(record);
      return record;
    });
  }
  async trash(id: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (record.deletedAt) return record;
      const availability = getCoordinatorActionAvailability(record).trash;
      if (!availability.available) throw new Error(availability.reason);
      record.deletedAt = Date.now();
      await this.save(record);
      return record;
    });
  }
  async restoreTrash(id: string): Promise<Coordinator> {
    return this.locks.runExclusive(id, async () => {
      const record = await this.get(id);
      if (!record.deletedAt) return record;
      record.deletedAt = undefined;
      await this.save(record);
      return record;
    });
  }
  private completeFinite(record: Coordinator, note?: string): void {
    if (record.lifecycle.kind !== 'finite')
      throw new Error('Ongoing main agents use checkpoints instead of completion.');
    if (Object.values(record.tasks).some((task) => !['done', 'cancelled'].includes(task.state)))
      throw new Error('Finish or cancel active tasks before completing this main agent.');
    if (
      Object.values(record.workItems).some(
        (item) => !['done', 'deferred', 'cancelled'].includes(item.state)
      )
    )
      throw new Error(
        'Resolve, defer or cancel open work items before completing this main agent.'
      );
    const now = Date.now();
    record.lifecycle.state = 'completed';
    record.lifecycle.completedAt = now;
    record.lifecycle.completionNote = note?.trim() || undefined;
    const workItems = Object.values(record.workItems);
    record.completionReport = {
      generatedAt: now,
      summary: note?.trim() || record.purpose || `${record.name} 已按完成条件结束。`,
      linkedProjectIds: [...record.projectIds],
      workItems: {
        total: workItems.length,
        done: workItems.filter((item) => item.state === 'done').length,
        deferred: workItems.filter((item) => item.state === 'deferred').length,
        cancelled: workItems.filter((item) => item.state === 'cancelled').length,
      },
      tasks: Object.values(record.tasks).map((task) => ({
        taskId: task.taskId,
        name: task.name,
        projectId: task.projectId,
        state: task.state,
        summary: task.result?.summary,
        commits: task.result?.commits ?? [],
        checks: task.result?.checks ?? [],
        unresolved: task.result?.unresolved ?? [],
        prUrls: task.result?.prUrls ?? [],
      })),
      checkpoints: [...record.checkpoints],
    };
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
      ...(record.taskId === taskId &&
        record.documentPushTarget && { documentPushTarget: record.documentPushTarget }),
      ...(record.taskId === taskId &&
        record.documentStorage && {
          documentStorage: {
            projectId: record.documentStorage.projectId,
            taskId: record.documentStorage.taskId,
            state: record.documentStorage.state,
          },
        }),
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
    dependsOn: string[] = [],
    documentRefs: ManagementDocumentReference[] = [],
    optimizationRunId?: string
  ): Promise<void> {
    const refs = documentReferencesSchema.parse(documentRefs);
    await this.assertDelegationGrants(caller, grantedProjectIds);
    await this.ownership.runExclusive('ownership', async () => {
      const records = await this.accessRecords(caller, params.id);
      const record = records.find(
        (entry) => entry.taskId === caller.taskId || entry.tasks[caller.taskId]
      );
      if (!record) {
        if (dependsOn.length || refs.length)
          throw new Error('Task dependencies and documents require a responsible main agent.');
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
        const documents: ManagementDocument[] = [];
        const seen = new Set<string>();
        const savedVersions = new Set<string>();
        for (const ref of refs) {
          const source = ref.coordinatorId ?? latest.id;
          const key = JSON.stringify([source, ref.path, ref.revision]);
          if (seen.has(key)) continue;
          seen.add(key);
          const document = await this.readDocument(source, ref.path, ref.revision, caller);
          const version = JSON.stringify([
            document.coordinatorId,
            document.path,
            document.revision,
          ]);
          if (savedVersions.has(version)) continue;
          savedVersions.add(version);
          documents.push(document);
        }
        if (
          documents.reduce((bytes, doc) => bytes + Buffer.byteLength(doc.content, 'utf8'), 0) >
          2 * 1024 * 1024
        )
          throw new Error('Choose management documents totaling no more than 2 MiB for this task.');
        latest.tasks[params.id] = {
          taskId: params.id,
          projectId: params.projectId,
          name: params.taskConfig.name,
          state: dependsOn.length ? 'blocked' : 'assigned',
          dependsOn: [...new Set(dependsOn)],
          ...(documents.length && { documents }),
          taskCreated: false,
          createdAt: Date.now(),
          ...(dependsOn.length && { blockedReason: 'Waiting for dependency review.' }),
          resultVersion: 0,
          submissions: {},
          ...(grantedProjectIds.length && { grantedProjectIds: [...new Set(grantedProjectIds)] }),
        };
        if (optimizationRunId) {
          const run = latest.optimizationRuns[optimizationRunId];
          if (!run) throw new Error('The optimization run no longer exists.');
          run.taskIds = [...new Set([...run.taskIds, params.id])];
          run.updatedAt = Date.now();
          const workItem = latest.workItems[run.workItemId];
          if (workItem) {
            workItem.taskIds = [...new Set([...workItem.taskIds, params.id])];
            workItem.updatedAt = Date.now();
          }
        }
        if (!latest.projectIds.includes(params.projectId)) {
          latest.projectIds = [...latest.projectIds, params.projectId];
        }
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
        if (caller && caller.taskId !== record.taskId)
          throw new Error('Only a conversation in this main agent can cancel this planned task.');
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
          if (caller && caller.taskId !== next.taskId)
            throw new Error('Only a conversation in this main agent can take over a task.');
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
    if (!record || (caller.taskId !== taskId && caller.taskId !== record.taskId))
      throw new Error('This task is not assigned to this caller.');
    const result = taskResultSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const receipt = await this.locks.runExclusive(record.id, async () => {
      const latest = await this.get(record.id);
      if (caller.taskId !== taskId && caller.taskId !== latest.taskId)
        throw new Error('Only a conversation in this main agent can submit another task result.');
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
    if (!record) throw new Error('Only a conversation in this main agent can acknowledge results.');
    await this.locks.runExclusive(record.id, async () => {
      const latest = await this.get(record.id);
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
      if (caller && caller.taskId !== record.taskId)
        throw new Error('Only a conversation in this main agent can review this task.');
      const task = record.tasks[taskId];
      if (!task?.result) throw new Error('This task has no submitted result to review.');
      if (task.resultVersion !== resultVersion)
        throw new Error('The result changed. Review the latest version before accepting.');
      if (task.review && (task.review.accepted !== accepted || task.review.note !== note))
        throw new Error('This result version was already reviewed. Refresh to see the decision.');
      if (!task.review) {
        task.state = accepted ? 'done' : 'changes_requested';
        task.review = { note, accepted, at: Date.now() };
        for (const run of Object.values(record.optimizationRuns)) {
          if (!run.taskIds.includes(taskId)) continue;
          if (accepted) {
            run.acceptedResultVersions = [
              ...run.acceptedResultVersions.filter((entry) => entry.taskId !== taskId),
              { taskId, version: resultVersion },
            ];
            if (
              run.taskIds.every((id) => record.tasks[id]?.state === 'done') &&
              canTransitionOptimizationRun(run.state, 'validating')
            ) {
              run.state = 'validating';
              run.stateHistory.push({
                state: 'validating',
                at: Date.now(),
                reason: '关联任务已验收。',
              });
            }
          } else if (run.state === 'validating') {
            run.state = 'implementing';
            run.stateHistory.push({
              state: 'implementing',
              at: Date.now(),
              reason: '任务需要继续修改。',
            });
          }
          run.updatedAt = Date.now();
        }
        await this.save(record);
      }
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
          let changed = false;
          for (const event of latest.events)
            if (event.state === 'queued') {
              event.state = 'pending';
              changed = true;
            }
          if (changed) await this.save(latest);
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
