import type { CreateTaskParams } from '@core/primitives/tasks/api';
import type { AgentCaller, AgentControlAction } from '../index';

/** Trusted domain operations shared by coordination and authenticated MCP delegation. */
export type DelegationResources = {
  prepare(
    caller: AgentCaller,
    request: Extract<AgentControlAction, { kind: 'create_task' }>,
    ids: {
      taskId: string;
      conversationId: string;
      role?: 'coordination';
    }
  ): Promise<CreateTaskParams>;
  findTask(taskId: string, projectId: string): Promise<'missing' | 'available' | 'deleted'>;
  create(params: CreateTaskParams): Promise<void>;
  activate(taskId: string, projectId: string): Promise<{ path: string }>;
  start(params: CreateTaskParams): Promise<void>;
};
