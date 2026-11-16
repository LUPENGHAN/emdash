import { createHash, randomUUID } from 'node:crypto';
import type { HostRef } from '@emdash/core/primitives/host/api';
import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { KeyedMutex } from '@emdash/shared/concurrency';
import { z } from 'zod';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Task } from '@core/primitives/tasks/api';
import type { AgentCaller, AgentControlAction, AgentControlResult } from '../api';
import type { TaskDelegationStatus } from '../api/delegations';
import type { BackgroundAgentAccess } from '../api/node/background-access';
import type { PendingAgentMessage } from '../api/pending-messages';

export type AgentProjectSummary = {
  id: string;
  name: string;
  host: HostRef;
  availability: 'available' | 'not-attached' | 'archived';
  baseline: { branch: string; remote: string | null } | null;
};
const messageRecordV1 = z.object({
  version: z.literal('1'),
  fingerprint: z.string(),
  promptId: z.string(),
  conversationId: z.string(),
  text: z.string(),
  phase: z.enum(['prepared', 'sending', 'accepted', 'pending']),
  queued: z.boolean().optional(),
  reason: z.string().optional(),
});
const messageRecord = defineVersionedSchema()
  .initial('1', messageRecordV1)
  .version(
    '2',
    messageRecordV1.extend({
      version: z.literal('2'),
      phase: z.enum(['prepared', 'sending', 'accepted', 'pending', 'handled', 'dismissed']),
    }),
    (record) => ({ ...record, version: '2' as const })
  )
  .build();
export type AgentMessageRecord = typeof messageRecord.Type;
export type AgentTaskSnapshot = Task & {
  branch?: string | null;
  branchObservedAt?: number | null;
  workspacePending?: boolean;
};
type Dependencies = {
  access: BackgroundAgentAccess;
  assertCaller(caller: AgentCaller): Promise<void>;
  projects(): Promise<AgentProjectSummary[]>;
  assertProject(projectId: string): Promise<void>;
  tasks(projectId: string): Promise<AgentTaskSnapshot[]>;
  task(taskId: string): Promise<AgentTaskSnapshot | null>;
  delegationStatus?(taskId: string): Promise<TaskDelegationStatus | null>;
  pullRequests?(taskId: string, caller: AgentCaller): Promise<unknown[]>;
  conversations(projectId: string): Promise<Conversation[]>;
  conversation(id: string): Promise<Conversation | null>;
  messages: {
    getAll(): Promise<Record<string, AgentMessageRecord | undefined>>;
    getOrThrow(key: string): Promise<AgentMessageRecord | null>;
    setOrThrow(key: string, record: AgentMessageRecord): Promise<void>;
  };
  emitMessagesChanged?(taskId: string): void;
  reportError?(error: unknown, id: string): void;
  deliver(
    conversation: Conversation,
    promptId: string,
    text: string
  ): Promise<{ status: 'accepted'; queued: boolean } | { status: 'pending'; reason: string }>;
};

/** Authenticated discovery, reads and message acceptance never require a renderer. */
export class BackgroundAgentControl {
  private readonly locks = new KeyedMutex();
  private readonly inFlight = new Set<string>();
  constructor(private readonly deps: Dependencies) {}
  private parseMessage(value: unknown): AgentMessageRecord {
    const parsed = messageRecord.safeParse(value);
    if (parsed.status !== 'ok') throw new Error(`Cannot read agent message: ${parsed.status}`);
    return messageRecord.schema.parse(parsed.data);
  }
  private async saveMessage(key: string, record: AgentMessageRecord, taskId: string) {
    await this.deps.messages.setOrThrow(key, record);
    this.deps.emitMessagesChanged?.(taskId);
  }
  private async messageTarget(taskId: string, conversationId: string) {
    const task = await this.deps.task(taskId);
    const conversation = await this.deps.conversation(conversationId);
    if (
      !task ||
      !conversation ||
      conversation.taskId !== taskId ||
      conversation.projectId !== task.projectId
    )
      throw new Error('The message target is unavailable.');
    await this.deps.assertProject(task.projectId);
    return conversation;
  }
  async pendingMessages(taskId: string): Promise<PendingAgentMessage[]> {
    const output: PendingAgentMessage[] = [];
    for (const [id, value] of Object.entries(await this.deps.messages.getAll())) {
      if (!value) continue;
      let record: AgentMessageRecord;
      try {
        record = this.parseMessage(value);
      } catch (error) {
        this.deps.reportError?.(error, id);
        const conversation =
          typeof value.conversationId === 'string'
            ? await this.deps.conversation(value.conversationId)
            : null;
        if (conversation?.taskId === taskId) throw error;
        continue;
      }
      if (this.inFlight.has(id) || !['prepared', 'pending', 'sending'].includes(record.phase))
        continue;
      const conversation = await this.deps.conversation(record.conversationId);
      if (!conversation || conversation.taskId !== taskId) continue;
      await this.messageTarget(taskId, record.conversationId);
      output.push({
        id,
        promptId: record.promptId,
        conversationId: record.conversationId,
        title: conversation.title,
        text: record.text,
        status: record.phase === 'sending' ? 'delivery_unknown' : 'pending',
        reason: record.reason,
      });
    }
    return output;
  }
  async resolvePendingMessage(
    taskId: string,
    id: string,
    resolution: 'handled' | 'dismissed'
  ): Promise<void> {
    await this.locks.runExclusive(id, async () => {
      const saved = await this.deps.messages.getOrThrow(id);
      if (!saved) throw new Error('The message no longer exists.');
      const record = this.parseMessage(saved);
      await this.messageTarget(taskId, record.conversationId);
      if (['accepted', 'handled', 'dismissed'].includes(record.phase)) return;
      await this.saveMessage(id, { ...record, phase: resolution }, taskId);
    });
  }
  async dispatch(
    caller: AgentCaller,
    action: AgentControlAction
  ): Promise<AgentControlResult | undefined> {
    if (
      ![
        'list_projects',
        'list_tasks',
        'get_task_status',
        'list_conversations',
        'send_message',
        'archive_task',
        'delete_task',
      ].includes(action.kind)
    )
      return undefined;
    await this.deps.assertCaller(caller);
    const json = (value: unknown) => ({ text: JSON.stringify(value) });
    switch (action.kind) {
      case 'list_projects': {
        const projects = [];
        for (const project of await this.deps.projects()) {
          if (action.query && !project.name.toLowerCase().includes(action.query.toLowerCase()))
            continue;
          if (await this.deps.access.mayAccessProject(caller, project.id, 'read'))
            projects.push(project);
        }
        return json(projects);
      }
      case 'list_tasks': {
        const projectId = action.projectId ?? caller.projectId;
        await this.assertProjectAccess(caller, projectId);
        const tasks = [];
        for (const task of await this.deps.tasks(projectId)) {
          if (task.type === 'coordination' || (!action.includeArchived && task.archivedAt))
            continue;
          if (await this.deps.access.mayAccessTask(caller, task, 'read')) tasks.push(task);
        }
        return json(tasks);
      }
      case 'get_task_status': {
        const task = await this.taskFor(caller, action.taskId, 'read');
        return json({
          task,
          coordination: await this.deps.access.getTaskCoordination(task.id),
          delegation: (await this.deps.delegationStatus?.(task.id)) ?? null,
          pullRequests: (await this.deps.pullRequests?.(task.id, caller)) ?? [],
        });
      }
      case 'list_conversations': {
        const task = action.taskId ? await this.taskFor(caller, action.taskId, 'read') : undefined;
        if (task && action.projectId && task.projectId !== action.projectId)
          throw new Error('The requested task does not belong to the target project.');
        const projectId = task?.projectId ?? action.projectId ?? caller.projectId;
        await this.assertProjectAccess(caller, projectId);
        const scopeTaskId = task?.id ?? (action.scope === 'task' ? caller.taskId : undefined);
        if (scopeTaskId === caller.taskId && projectId !== caller.projectId)
          throw new Error('Specify a target task_id for task-scoped cross-project discovery.');
        const conversations = [];
        for (const conversation of await this.deps.conversations(projectId)) {
          if (scopeTaskId && conversation.taskId !== scopeTaskId) continue;
          if (!(await this.deps.conversation(conversation.id))) continue;
          const target = await this.deps.task(conversation.taskId);
          if (!target || target.archivedAt) continue;
          if (await this.deps.access.mayAccessTask(caller, target, 'read'))
            conversations.push(conversation);
        }
        return json(conversations);
      }
      case 'archive_task':
      case 'delete_task':
        await this.taskFor(caller, action.taskId, 'control');
        return undefined;
      case 'send_message':
        return this.send(caller, action);
      default:
        return undefined;
    }
  }
  private async assertProjectAccess(caller: AgentCaller, projectId: string): Promise<void> {
    if (!(await this.deps.access.mayAccessProject(caller, projectId, 'read')))
      throw new Error(`Project permission denied: ${projectId}`);
    await this.deps.assertProject(projectId);
  }
  private async taskFor(
    caller: AgentCaller,
    taskId: string,
    intent: 'read' | 'control'
  ): Promise<AgentTaskSnapshot> {
    const task = await this.deps.task(taskId);
    if (!task) throw new Error('The target task is unavailable or deleted.');
    if (!(await this.deps.access.mayAccessTask(caller, task, intent)))
      throw new Error('Task permission denied. The task may belong to another main agent.');
    await this.deps.assertProject(task.projectId);
    return task;
  }
  private async send(
    caller: AgentCaller,
    action: Extract<AgentControlAction, { kind: 'send_message' }>
  ): Promise<AgentControlResult> {
    const conversation = await this.deps.conversation(action.conversationId);
    if (!conversation) throw new Error('The target conversation is unavailable or deleted.');
    const task = await this.taskFor(caller, conversation.taskId, 'control');
    if (task.archivedAt) throw new Error('The target task is archived.');
    if (task.projectId !== conversation.projectId)
      throw new Error('The target conversation has an invalid project binding.');
    const requestId = action.requestId ?? randomUUID();
    const key = createHash('sha256')
      .update(JSON.stringify([caller.conversationId, requestId]))
      .digest('hex');
    return this.locks.runExclusive(key, async () => {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([action.conversationId, action.text]))
        .digest('hex');
      const saved = await this.deps.messages.getOrThrow(key);
      let record: AgentMessageRecord = saved
        ? this.parseMessage(saved)
        : {
            version: '2' as const,
            fingerprint,
            promptId: randomUUID(),
            conversationId: conversation.id,
            text: action.text,
            phase: 'prepared' as AgentMessageRecord['phase'],
          };
      if (record.fingerprint !== fingerprint)
        throw new Error('This message request_id has different content or a different target.');
      const result = () => ({
        text: JSON.stringify({
          request_id: requestId,
          prompt_id: record.promptId,
          conversation_id: conversation.id,
          status: record.phase === 'sending' ? 'delivery_unknown' : record.phase,
          queued: record.queued,
          reason: record.reason,
        }),
      });
      if (['accepted', 'sending', 'handled', 'dismissed'].includes(record.phase)) return result();
      this.inFlight.add(key);
      try {
        await this.saveMessage(key, record, task.id);
        record = { ...record, phase: 'sending', reason: undefined };
        await this.saveMessage(key, record, task.id);
        try {
          const delivered = await this.deps.deliver(conversation, record.promptId, record.text);
          record =
            delivered.status === 'accepted'
              ? { ...record, phase: 'accepted', queued: delivered.queued }
              : { ...record, phase: 'pending', reason: delivered.reason };
          await this.saveMessage(key, record, task.id);
        } catch (error) {
          // Acceptance may have reached the host. Preserve uncertainty instead of replaying input.
          record = { ...record, reason: error instanceof Error ? error.message : String(error) };
          await this.saveMessage(key, record, task.id);
        }
        return result();
      } finally {
        this.inFlight.delete(key);
        this.deps.emitMessagesChanged?.(task.id);
      }
    });
  }
}
