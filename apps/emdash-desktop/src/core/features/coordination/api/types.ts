import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { pushTargetSchema, type PushTarget } from '@emdash/core/runtimes/git/api';
import { z } from 'zod';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import { managementDocumentSchema, type ManagementDocument } from './documents';
import {
  livePromotionSchema,
  optimizationRunSchema,
  optimizationSuggestionSchema,
  type LivePromotion,
  type OptimizationRun,
  type OptimizationSuggestion,
} from './optimization';

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
export const projectAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('selected'), projectIds: z.array(z.string().min(1)) }),
]);
export type ProjectAccess = z.infer<typeof projectAccessSchema>;
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
  state: 'assigned' | 'blocked' | 'cancelled' | 'review' | 'changes_requested' | 'done';
  result?: TaskResult;
  resultVersion: number;
  submissions: Record<string, { version: number; fingerprint: string }>;
  review?: { note: string; accepted: boolean; at: number };
  grantedProjectIds?: string[];
  ownershipHistory?: { from: string | null; to: string; at: number }[];
  documents?: ManagementDocument[];
  dependsOn?: string[];
  blockedReason?: string;
  taskCreated?: boolean;
  createdAt?: number;
  dependencyResults?: { taskId: string; projectId: string; version: number; commits: string[] }[];
};
export type ResultEvent = {
  id: string;
  taskId: string;
  version: number;
  result: TaskResult;
  state: 'pending' | 'queued' | 'acknowledged';
  error?: string;
};
export const workspaceLifecycleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('finite'),
    state: z.enum(['active', 'waiting', 'ready_to_complete', 'completed', 'archived']),
    completedAt: z.number().optional(),
    completionNote: z.string().optional(),
    archivedFrom: z.enum(['active', 'waiting', 'ready_to_complete', 'completed']).optional(),
  }),
  z.object({
    kind: z.literal('ongoing'),
    state: z.enum(['active', 'paused', 'archived']),
    lastCheckpointAt: z.number().optional(),
    archivedFrom: z.enum(['active', 'paused']).optional(),
  }),
]);
export type WorkspaceLifecycle = z.infer<typeof workspaceLifecycleSchema>;

export const workspaceWorkItemSchema = z.object({
  id: z.string(),
  kind: z
    .enum(['delivery', 'analysis', 'coordination', 'experience-improvement'])
    .default('delivery'),
  origin: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('user') }),
      z.object({ kind: z.literal('agent'), conversationId: z.string().min(1) }),
      z.object({ kind: z.literal('page-feedback'), surface: z.string().min(1) }),
      z.object({ kind: z.literal('accepted-suggestion'), suggestionId: z.string().uuid() }),
    ])
    .default({ kind: 'user' }),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(20_000).optional(),
  state: z.enum(['open', 'in_progress', 'waiting', 'review', 'done', 'deferred', 'cancelled']),
  taskIds: z.array(z.string()).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  resolvedAt: z.number().optional(),
});
export type WorkspaceWorkItem = z.infer<typeof workspaceWorkItemSchema>;

export const workspaceCheckpointSchema = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(200),
  workItemIds: z.array(z.string()),
  createdAt: z.number(),
});
export type WorkspaceCheckpoint = z.infer<typeof workspaceCheckpointSchema>;

export const workspaceProjectImportSchema = z.object({
  requestId: z.string().uuid(),
  repositoryUrl: z.string().min(1),
  name: z.string().min(1),
  directory: z.string().min(1),
  state: z.enum(['cloning', 'registering', 'ready', 'failed', 'cancelled']),
  progress: z.number().min(0).max(100).optional(),
  projectId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WorkspaceProjectImport = z.infer<typeof workspaceProjectImportSchema>;

export const workspaceCompletionReportSchema = z.object({
  generatedAt: z.number(),
  summary: z.string(),
  linkedProjectIds: z.array(z.string()),
  workItems: z.object({
    total: z.number(),
    done: z.number(),
    deferred: z.number(),
    cancelled: z.number(),
  }),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      name: z.string(),
      projectId: z.string(),
      state: z.string(),
      summary: z.string().optional(),
      commits: z.array(z.string()),
      checks: z.array(
        z.object({ command: z.string(), passed: z.boolean(), output: z.string().optional() })
      ),
      unresolved: z.array(z.string()),
      prUrls: z.array(z.string()),
    })
  ),
  checkpoints: z.array(workspaceCheckpointSchema),
});
export type WorkspaceCompletionReport = z.infer<typeof workspaceCompletionReportSchema>;

export type Coordinator = {
  version: '12';
  id: string;
  kind: 'project' | 'cross-project';
  name: string;
  projectId: string;
  projectIds: string[];
  projectAccess?: ProjectAccess;
  taskId: string;
  conversationId: string;
  primary: AgentSelection;
  delegationDefaults: AgentSelection;
  params?: CreateTaskParams;
  tasks: Record<string, AssignedTask>;
  events: ResultEvent[];
  creationFingerprint?: string;
  documentPushTarget?: PushTarget;
  documentStorage?: DocumentStorage;
  documentMigration?: DocumentMigration;
  documentStorageHistory?: DocumentStorage[];
  purpose: string;
  lifecycle: WorkspaceLifecycle;
  workItems: Record<string, WorkspaceWorkItem>;
  checkpoints: WorkspaceCheckpoint[];
  completionReport?: WorkspaceCompletionReport;
  projectImports?: Record<string, WorkspaceProjectImport>;
  optimizationRuns: Record<string, OptimizationRun>;
  optimizationSuggestions: Record<string, OptimizationSuggestion>;
  livePromotions: Record<string, LivePromotion>;
  migratedFromId?: string;
  supersededById?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
};
export type DocumentStorage = {
  projectId: string;
  taskId: string;
  params: CreateTaskParams;
  state: 'preparing' | 'ready';
};
export type DocumentMigration = {
  id: string;
  fingerprint: string;
  source: DocumentStorage;
  target: DocumentStorage;
  files: ManagementDocument[];
  copied: { path: string; revision: string }[];
  phase: 'prepared' | 'copying' | 'verified' | 'complete' | 'cancelled';
  error?: string;
};
export type CoordinationEvent = { coordinatorId: string; projectId: string; taskId?: string };
export type TakeoverPreview = {
  taskId: string;
  projectId: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
};

export type CoordinatorActionAvailability = {
  completeAndArchive: { available: boolean; reason?: string };
  trash: { available: boolean; reason?: string };
};

export function getCoordinatorActionAvailability(
  record: Coordinator
): CoordinatorActionAvailability {
  const unfinishedTasks = Object.values(record.tasks).filter(
    (task) => !['done', 'cancelled'].includes(task.state)
  );
  const unresolvedWorkItems = Object.values(record.workItems).filter(
    (item) => !['done', 'deferred', 'cancelled'].includes(item.state)
  );
  const undeliveredResults = record.events.filter((event) => event.state !== 'acknowledged');
  const deletedReason = record.deletedAt ? '该工作区已在废纸篓中。' : undefined;
  const completeReason =
    deletedReason ??
    (record.lifecycle.kind !== 'finite'
      ? '长期工作区不使用“完成并归档”。'
      : record.lifecycle.state === 'archived'
        ? '该工作区已经归档。'
        : record.lifecycle.state === 'completed'
          ? '该工作区已经完成，可直接归档。'
          : unfinishedTasks.length
            ? `还有 ${unfinishedTasks.length} 个执行任务未结束。`
            : unresolvedWorkItems.length
              ? `还有 ${unresolvedWorkItems.length} 个工作项未处理。`
              : undefined);
  const trashReason =
    deletedReason ??
    (unfinishedTasks.length
      ? `还有 ${unfinishedTasks.length} 个执行任务未结束。`
      : undeliveredResults.length
        ? `还有 ${undeliveredResults.length} 个任务结果未确认。`
        : undefined);
  return {
    completeAndArchive: {
      available: !completeReason,
      ...(completeReason && { reason: completeReason }),
    },
    trash: { available: !trashReason, ...(trashReason && { reason: trashReason }) },
  };
}

const coordinatorV1 = z.object({
  version: z.literal('1'),
  id: z.string(),
  kind: z.enum(['project', 'cross-project']),
  name: z.string(),
  projectId: z.string(),
  projectIds: z.array(z.string()),
  projectAccess: projectAccessSchema.optional(),
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
      grantedProjectIds: z.array(z.string()).optional(),
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
  creationFingerprint: z.string().optional(),
});

const coordinatorV3 = coordinatorV1.extend({
  version: z.literal('3'),
  tasks: z.record(
    z.string(),
    coordinatorV1.shape.tasks.valueType.extend({
      ownershipHistory: z
        .array(z.object({ from: z.string().nullable(), to: z.string(), at: z.number() }))
        .optional(),
    })
  ),
});
const coordinatorV4 = coordinatorV3.extend({
  version: z.literal('4'),
  tasks: z.record(
    z.string(),
    coordinatorV3.shape.tasks.valueType.extend({
      state: z.enum(['assigned', 'blocked', 'cancelled', 'review', 'changes_requested', 'done']),
      dependsOn: z.array(z.string()).optional(),
      blockedReason: z.string().optional(),
      taskCreated: z.boolean().optional(),
      createdAt: z.number().optional(),
      dependencyResults: z
        .array(
          z.object({
            taskId: z.string(),
            projectId: z.string(),
            version: z.number().int().positive(),
            commits: z.array(z.string()),
          })
        )
        .optional(),
    })
  ),
});

const coordinatorV6 = coordinatorV1.extend({
  version: z.literal('6'),
  tasks: z.record(
    z.string(),
    coordinatorV4.shape.tasks.valueType.extend({
      documents: z.array(managementDocumentSchema).max(16).optional(),
    })
  ),
});

const coordinatorV7 = coordinatorV6.extend({
  version: z.literal('7'),
  documentPushTarget: pushTargetSchema.optional(),
});
const documentStorageSchema = z.object({
  projectId: z.string(),
  taskId: z.string(),
  params: z.custom<CreateTaskParams>(),
  state: z.enum(['preparing', 'ready']),
});
const coordinatorV8 = coordinatorV7.extend({
  version: z.literal('8'),
  documentStorage: documentStorageSchema.optional(),
});

export const coordinatorRecord = defineVersionedSchema()
  .initial('1', coordinatorV1)
  .version('2', coordinatorV1.extend({ version: z.literal('2') }), (record) => ({
    ...record,
    version: '2' as const,
  }))
  .version('3', coordinatorV3, (record) => ({ ...record, version: '3' as const }))
  .version('4', coordinatorV4, (record) => ({ ...record, version: '4' as const }))
  .version(
    '5',
    coordinatorV1.extend({ version: z.literal('5'), tasks: coordinatorV4.shape.tasks }),
    (record) => ({ ...record, version: '5' as const })
  )
  .version('6', coordinatorV6, (record) => ({ ...record, version: '6' as const }))
  .version('7', coordinatorV7, (record) => ({ ...record, version: '7' as const }))
  .version('8', coordinatorV8, (record) => ({ ...record, version: '8' as const }))
  .version(
    '9',
    coordinatorV8.extend({
      version: z.literal('9'),
      documentMigration: z
        .object({
          id: z.string(),
          fingerprint: z.string(),
          source: documentStorageSchema,
          target: documentStorageSchema,
          files: z.array(managementDocumentSchema),
          copied: z.array(z.object({ path: z.string(), revision: z.string() })),
          phase: z.enum(['prepared', 'copying', 'verified', 'complete', 'cancelled']),
          error: z.string().optional(),
        })
        .optional(),
      documentStorageHistory: z.array(documentStorageSchema).optional(),
    }),
    (record) => ({ ...record, version: '9' as const })
  )
  .version(
    '10',
    coordinatorV8.extend({
      version: z.literal('10'),
      documentMigration: z
        .object({
          id: z.string(),
          fingerprint: z.string(),
          source: documentStorageSchema,
          target: documentStorageSchema,
          files: z.array(managementDocumentSchema),
          copied: z.array(z.object({ path: z.string(), revision: z.string() })),
          phase: z.enum(['prepared', 'copying', 'verified', 'complete', 'cancelled']),
          error: z.string().optional(),
        })
        .optional(),
      documentStorageHistory: z.array(documentStorageSchema).optional(),
      purpose: z.string().max(20_000),
      lifecycle: workspaceLifecycleSchema,
      workItems: z.record(z.string(), workspaceWorkItemSchema),
      checkpoints: z.array(workspaceCheckpointSchema),
      completionReport: workspaceCompletionReportSchema.optional(),
      projectImports: z.record(z.string(), workspaceProjectImportSchema).optional(),
      migratedFromId: z.string().optional(),
      supersededById: z.string().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
    (record) => ({
      ...record,
      version: '10' as const,
      purpose: '',
      lifecycle:
        record.kind === 'project'
          ? ({ kind: 'ongoing', state: 'active' } as const)
          : ({ kind: 'finite', state: 'active' } as const),
      workItems: {},
      checkpoints: [],
      createdAt: 0,
      updatedAt: 0,
    })
  )
  .version(
    '11',
    coordinatorV8.extend({
      version: z.literal('11'),
      documentMigration: z
        .object({
          id: z.string(),
          fingerprint: z.string(),
          source: documentStorageSchema,
          target: documentStorageSchema,
          files: z.array(managementDocumentSchema),
          copied: z.array(z.object({ path: z.string(), revision: z.string() })),
          phase: z.enum(['prepared', 'copying', 'verified', 'complete', 'cancelled']),
          error: z.string().optional(),
        })
        .optional(),
      documentStorageHistory: z.array(documentStorageSchema).optional(),
      purpose: z.string().max(20_000),
      lifecycle: workspaceLifecycleSchema,
      workItems: z.record(z.string(), workspaceWorkItemSchema),
      checkpoints: z.array(workspaceCheckpointSchema),
      completionReport: workspaceCompletionReportSchema.optional(),
      projectImports: z.record(z.string(), workspaceProjectImportSchema).optional(),
      optimizationRuns: z.record(z.string(), optimizationRunSchema),
      optimizationSuggestions: z.record(z.string(), optimizationSuggestionSchema),
      livePromotions: z.record(z.string(), livePromotionSchema),
      migratedFromId: z.string().optional(),
      supersededById: z.string().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
    (record) => ({
      ...record,
      version: '11' as const,
      optimizationRuns: {},
      optimizationSuggestions: {},
      livePromotions: {},
    })
  )
  .version(
    '12',
    coordinatorV8.extend({
      version: z.literal('12'),
      documentMigration: z
        .object({
          id: z.string(),
          fingerprint: z.string(),
          source: documentStorageSchema,
          target: documentStorageSchema,
          files: z.array(managementDocumentSchema),
          copied: z.array(z.object({ path: z.string(), revision: z.string() })),
          phase: z.enum(['prepared', 'copying', 'verified', 'complete', 'cancelled']),
          error: z.string().optional(),
        })
        .optional(),
      documentStorageHistory: z.array(documentStorageSchema).optional(),
      purpose: z.string().max(20_000),
      lifecycle: workspaceLifecycleSchema,
      workItems: z.record(z.string(), workspaceWorkItemSchema),
      checkpoints: z.array(workspaceCheckpointSchema),
      completionReport: workspaceCompletionReportSchema.optional(),
      projectImports: z.record(z.string(), workspaceProjectImportSchema).optional(),
      optimizationRuns: z.record(z.string(), optimizationRunSchema),
      optimizationSuggestions: z.record(z.string(), optimizationSuggestionSchema),
      livePromotions: z.record(z.string(), livePromotionSchema),
      migratedFromId: z.string().optional(),
      supersededById: z.string().optional(),
      deletedAt: z.number().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
    (record) => ({ ...record, version: '12' as const })
  )
  .build();
