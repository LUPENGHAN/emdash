import type { AgentCaller } from '../index';

export type BackgroundAgentAccess = {
  mayAccessProject(
    caller: AgentCaller,
    projectId: string,
    intent: 'read' | 'delegate'
  ): Promise<boolean>;
  mayAccessTask(
    caller: AgentCaller,
    task: { id: string; projectId: string },
    intent: 'read' | 'control'
  ): Promise<boolean>;
  getTaskCoordination(taskId: string): Promise<unknown>;
};
