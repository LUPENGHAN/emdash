import { asAgentProviderId } from '@emdash/plugins/agents/types';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Task } from '@core/primitives/tasks/api';
import type { AgentCaller } from '../api';
import type { BackgroundAgentAccess } from '../api/node/background-access';
import {
  BackgroundAgentControl,
  type AgentMessageRecord,
  type AgentProjectSummary,
} from './background-agent-control';

const caller: AgentCaller = {
  conversationId: 'main-conversation',
  taskId: 'main',
  projectId: 'a',
  providerId: 'claude',
  title: 'Main',
  cwd: null,
};
function task(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    name: id,
    type: 'task',
    status: 'in_progress',
    prs: [],
    conversations: {},
    isPinned: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    statusChangedAt: '2026-01-01',
  };
}
function conversation(id: string, projectId = 'b', taskId = 'worker'): Conversation {
  return {
    id,
    taskId,
    projectId,
    title: id,
    providerId: asAgentProviderId('opencode'),
    type: 'acp',
    lastInteractedAt: null,
    isInitialConversation: true,
  };
}
function setup() {
  const records = new Map<string, AgentMessageRecord>();
  const tasks = [
    task('worker', 'b'),
    { ...task('hidden-main', 'b'), type: 'coordination' as const },
    { ...task('archived', 'b'), archivedAt: '2026-01-02' },
  ];
  const conversations = [conversation('target')];
  const projects: AgentProjectSummary[] = ['a', 'b'].map((id) => ({
    id,
    name: `Project ${id}`,
    host: { type: 'local', id: 'local' },
    availability: 'available',
    baseline: { branch: 'develop', remote: null },
  }));
  const deps = {
    access: {
      mayAccessProject: vi.fn<BackgroundAgentAccess['mayAccessProject']>(async () => true),
      mayAccessTask: vi.fn<BackgroundAgentAccess['mayAccessTask']>(async () => true),
      getTaskCoordination: vi.fn(async () => ({ coordinatorId: 'owner', resultVersion: 2 })),
    },
    assertCaller: vi.fn(async () => {}),
    projects: async () => projects,
    assertProject: vi.fn(async () => {}),
    tasks: async (projectId: string) => tasks.filter((task) => task.projectId === projectId),
    task: async (id: string) => tasks.find((task) => task.id === id) ?? null,
    conversations: async (projectId: string) =>
      conversations.filter((conversation) => conversation.projectId === projectId),
    conversation: async (id: string) =>
      conversations.find((conversation) => conversation.id === id) ?? null,
    messages: {
      getOrThrow: async (id: string) => structuredClone(records.get(id) ?? null),
      setOrThrow: async (id: string, value: AgentMessageRecord) => {
        records.set(id, structuredClone(value));
      },
    },
    deliver: vi.fn<ConstructorParameters<typeof BackgroundAgentControl>[0]['deliver']>(
      async () => ({ status: 'accepted', queued: true })
    ),
  };
  return { records, deps, tasks, conversations, service: new BackgroundAgentControl(deps) };
}
describe('background agent discovery and messaging', () => {
  it('returns only authorized projects and honors explicit target project IDs without a renderer', async () => {
    const test = setup();
    test.deps.access.mayAccessProject.mockImplementation(async (_caller, id) => id === 'b');
    const projects = await test.service.dispatch(caller, { kind: 'list_projects' });
    expect(JSON.parse(projects!.text).map((project: AgentProjectSummary) => project.id)).toEqual([
      'b',
    ]);
    const listed = await test.service.dispatch(caller, {
      kind: 'list_tasks',
      projectId: 'b',
      includeArchived: false,
    });
    expect(JSON.parse(listed!.text).map((task: Task) => task.id)).toEqual(['worker']);
    await expect(
      test.service.dispatch(caller, { kind: 'list_tasks', projectId: 'a', includeArchived: false })
    ).rejects.toThrow('permission denied');
  });
  it('authorizes task-scoped conversation discovery against the target task and rejects project mismatches', async () => {
    const test = setup();
    const listed = await test.service.dispatch(caller, {
      kind: 'list_conversations',
      scope: 'task',
      taskId: 'worker',
    });
    expect(JSON.parse(listed!.text).map((conversation: Conversation) => conversation.id)).toEqual([
      'target',
    ]);
    await expect(
      test.service.dispatch(caller, {
        kind: 'list_conversations',
        scope: 'task',
        taskId: 'worker',
        projectId: 'a',
      })
    ).rejects.toThrow('does not belong');
    const status = await test.service.dispatch(caller, {
      kind: 'get_task_status',
      taskId: 'worker',
    });
    expect(JSON.parse(status!.text).coordination.resultVersion).toBe(2);
  });
  it('deduplicates concurrent message requests and retains the acceptance across service recreation', async () => {
    const test = setup();
    const action = {
      kind: 'send_message' as const,
      conversationId: 'target',
      text: 'Inspect the diff',
      requestId: 'same',
    };
    const [one, two] = await Promise.all([
      test.service.dispatch(caller, action),
      test.service.dispatch(caller, action),
    ]);
    expect(two).toEqual(one);
    expect(test.deps.deliver).toHaveBeenCalledOnce();
    expect(await new BackgroundAgentControl(test.deps).dispatch(caller, action)).toEqual(one);
    expect(test.deps.deliver).toHaveBeenCalledOnce();
    await expect(test.service.dispatch(caller, { ...action, text: 'Changed' })).rejects.toThrow(
      'different content'
    );
  });
  it('does not replay a message whose host acceptance became unknown', async () => {
    const test = setup();
    test.deps.deliver.mockRejectedValueOnce(new Error('Confirmation disconnected'));
    const action = {
      kind: 'send_message' as const,
      conversationId: 'target',
      text: 'Implement',
      requestId: 'ambiguous',
    };
    const first = await test.service.dispatch(caller, action);
    expect(JSON.parse(first!.text).status).toBe('delivery_unknown');
    await new BackgroundAgentControl(test.deps).dispatch(caller, action);
    expect(test.deps.deliver).toHaveBeenCalledOnce();
  });
  it('retains a known pending delivery and retries it with the same prompt ID', async () => {
    const test = setup();
    test.deps.deliver.mockResolvedValueOnce({
      status: 'pending',
      reason: 'Terminal input not injected',
    });
    const action = {
      kind: 'send_message' as const,
      conversationId: 'target',
      text: 'Follow up',
      requestId: 'pending',
    };
    const first = JSON.parse((await test.service.dispatch(caller, action))!.text);
    expect(first.status).toBe('pending');
    const retried = JSON.parse((await test.service.dispatch(caller, action))!.text);
    expect(retried.status).toBe('accepted');
    expect(retried.prompt_id).toBe(first.prompt_id);
  });
  it('authorizes archive and deletion before leaving their user confirmation to the renderer', async () => {
    const test = setup();
    expect(
      await test.service.dispatch(caller, { kind: 'archive_task', taskId: 'worker' })
    ).toBeUndefined();
    test.deps.access.mayAccessTask.mockResolvedValue(false);
    await expect(
      test.service.dispatch(caller, { kind: 'delete_task', taskId: 'worker' })
    ).rejects.toThrow('Task permission denied');
    expect(test.deps.deliver).not.toHaveBeenCalled();
  });

  it('rechecks permissions before using a saved receipt and never delivers to a foreign task', async () => {
    const test = setup();
    test.deps.access.mayAccessTask.mockResolvedValue(false);
    await expect(
      test.service.dispatch(caller, {
        kind: 'send_message',
        conversationId: 'target',
        text: 'No',
        requestId: 'denied',
      })
    ).rejects.toThrow('Task permission denied');
    expect(test.deps.deliver).not.toHaveBeenCalled();
    expect(test.records.size).toBe(0);
    test.deps.assertCaller.mockRejectedValue(new Error('Caller was deleted'));
    await expect(test.service.dispatch(caller, { kind: 'list_projects' })).rejects.toThrow(
      'Caller was deleted'
    );
  });
});
