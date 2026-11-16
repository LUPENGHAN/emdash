import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { z } from 'zod';
import type { CreateTaskParams } from '@core/primitives/tasks/api';

export const agentSelectionSchema = z.object({
  agent: z.string().optional(),
  connection: z.enum(['gateway', 'official']).optional(),
  supplierId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().nullable().optional(),
});
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export type ResolvedAgentSelection = {
  values: AgentSelection & { agent: string };
  sources: Partial<Record<keyof AgentSelection, 'selection' | 'agent-default' | 'adapter-default'>>;
  effortOptions: Record<string, { label: string; level: number }>;
  errors: string[];
};
export const taskResultSchema = z.object({
  summary: z.string().trim().min(1),
  commits: z.array(z.string()).default([]),
  checks: z
    .array(z.object({ command: z.string(), passed: z.boolean(), output: z.string().optional() }))
    .default([]),
  unresolved: z.array(z.string()).default([]),
  prUrls: z.array(z.string()).default([]),
});
export type TaskResult = z.infer<typeof taskResultSchema>;
export type AssignedTask = {
  taskId: string;
  projectId: string;
  name: string;
  state: 'assigned' | 'review' | 'changes_requested' | 'done';
  result?: TaskResult;
  resultVersion: number;
  submissions: Record<string, { version: number; fingerprint: string }>;
  review?: { note: string; accepted: boolean; at: number };
};
export type ResultEvent = {
  id: string;
  taskId: string;
  version: number;
  result: TaskResult;
  state: 'pending' | 'queued' | 'acknowledged';
  error?: string;
};
export type Coordinator = {
  version: '1';
  id: string;
  kind: 'project' | 'cross-project';
  name: string;
  projectId: string;
  projectIds: string[];
  taskId: string;
  conversationId: string;
  primary: AgentSelection;
  delegationDefaults: AgentSelection;
  params?: CreateTaskParams;
  tasks: Record<string, AssignedTask>;
  events: ResultEvent[];
};
export type CoordinationEvent = { coordinatorId: string; projectId: string };

export const coordinatorRecord = defineVersionedSchema()
  .initial(
    '1',
    z.object({
      version: z.literal('1'),
      id: z.string(),
      kind: z.enum(['project', 'cross-project']),
      name: z.string(),
      projectId: z.string(),
      projectIds: z.array(z.string()),
      taskId: z.string(),
      conversationId: z.string(),
      primary: agentSelectionSchema,
      delegationDefaults: agentSelectionSchema,
      params: z.custom<CreateTaskParams>().optional(),
      tasks: z.record(
        z.string(),
        z.object({
          taskId: z.string(),
          projectId: z.string(),
          name: z.string(),
          state: z.enum(['assigned', 'review', 'changes_requested', 'done']),
          result: taskResultSchema.optional(),
          resultVersion: z.number().int().nonnegative(),
          submissions: z.record(
            z.string(),
            z.object({ version: z.number().int().positive(), fingerprint: z.string() })
          ),
          review: z.object({ note: z.string(), accepted: z.boolean(), at: z.number() }).optional(),
        })
      ),
      events: z.array(
        z.object({
          id: z.string(),
          taskId: z.string(),
          version: z.number().int().positive(),
          result: taskResultSchema,
          state: z.enum(['pending', 'queued', 'acknowledged']),
          error: z.string().optional(),
        })
      ),
    })
  )
  .build();
