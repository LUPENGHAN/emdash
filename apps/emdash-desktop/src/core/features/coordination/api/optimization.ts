import { z } from 'zod';

export const optimizationRiskSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string().trim().min(1)).default([]),
  requiresUserConfirmation: z.boolean(),
});
export type OptimizationRisk = z.infer<typeof optimizationRiskSchema>;

export const optimizationRunStateSchema = z.enum([
  'captured',
  'investigating',
  'planning',
  'waiting_for_approval',
  'implementing',
  'validating',
  'ready_to_apply',
  'applying',
  'observing',
  'accepted',
  'blocked',
  'failed',
  'rolled_back',
]);
export type OptimizationRunState = z.infer<typeof optimizationRunStateSchema>;

export const optimizationRunSchema = z.object({
  id: z.string().uuid(),
  workItemId: z.string().uuid(),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual'), conversationId: z.string().min(1) }),
    z.object({
      kind: z.literal('accepted-suggestion'),
      conversationId: z.string().min(1),
      suggestionId: z.string().uuid(),
    }),
  ]),
  executionMode: z.enum(['automatic', 'proposal-first']),
  experienceConfirmation: z.enum(['user', 'acceptance-criteria']),
  objective: z.string().trim().min(1).max(20_000),
  observedProblem: z.string().trim().min(1).max(20_000),
  capturedContext: z.object({
    surface: z.string().max(500).optional(),
    route: z.string().max(2_000).optional(),
    selectedEntityRefs: z.array(z.string().max(1_000)).max(50).default([]),
    screenshotRef: z.string().max(2_000).optional(),
    logRefs: z.array(z.string().max(2_000)).max(20).default([]),
  }),
  baseline: z.object({
    liveRevision: z.string().optional(),
    appVersion: z.string(),
  }),
  risk: optimizationRiskSchema,
  state: optimizationRunStateSchema,
  taskIds: z.array(z.string()).default([]),
  acceptedResultVersions: z
    .array(z.object({ taskId: z.string(), version: z.number().int().positive() }))
    .default([]),
  promotionId: z.string().uuid().optional(),
  observation: z
    .object({
      technicalValidationPassed: z.boolean(),
      userDecision: z.enum(['pending', 'accepted', 'continue', 'rollback']),
      note: z.string().max(20_000).optional(),
      updatedAt: z.number(),
    })
    .optional(),
  stateHistory: z.array(
    z.object({ state: optimizationRunStateSchema, at: z.number(), reason: z.string().optional() })
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type OptimizationRun = z.infer<typeof optimizationRunSchema>;

export const optimizationSuggestionSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  observedPattern: z.string().trim().min(1).max(20_000),
  proposedOutcome: z.string().trim().min(1).max(20_000),
  evidenceRefs: z.array(z.string().max(2_000)).max(50).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
  state: z.enum(['new', 'accepted', 'dismissed', 'expired']),
  workItemId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type OptimizationSuggestion = z.infer<typeof optimizationSuggestionSchema>;

export const livePromotionSchema = z.object({
  id: z.string().uuid(),
  optimizationRunId: z.string().uuid().optional(),
  fromRevision: z.string().min(1),
  toRevision: z.string().min(1),
  commits: z.array(
    z.object({ projectId: z.string(), taskId: z.string(), hash: z.string().min(7) })
  ),
  changeClass: z.enum(['renderer', 'main-runtime', 'dependency', 'data-migration']),
  checks: z.array(
    z.object({ command: z.string(), passed: z.boolean(), output: z.string().optional() })
  ),
  backupSetId: z.string().optional(),
  state: z.enum(['prepared', 'waiting_for_idle', 'applying', 'healthy', 'failed', 'rolled_back']),
  lastKnownGoodRevision: z.string().optional(),
  createdAt: z.number(),
  appliedAt: z.number().optional(),
  updatedAt: z.number(),
});
export type LivePromotion = z.infer<typeof livePromotionSchema>;

export const optimizationStateTransitions: Readonly<
  Record<OptimizationRunState, readonly OptimizationRunState[]>
> = {
  captured: ['investigating', 'blocked', 'failed'],
  investigating: ['planning', 'blocked', 'failed'],
  planning: ['waiting_for_approval', 'implementing', 'blocked', 'failed'],
  waiting_for_approval: ['implementing', 'blocked', 'failed'],
  implementing: ['validating', 'blocked', 'failed'],
  validating: ['implementing', 'ready_to_apply', 'blocked', 'failed'],
  ready_to_apply: ['applying', 'blocked', 'failed'],
  applying: ['observing', 'failed', 'rolled_back'],
  observing: ['accepted', 'implementing', 'rolled_back', 'failed'],
  accepted: [],
  blocked: ['investigating', 'planning', 'implementing', 'validating', 'ready_to_apply', 'failed'],
  failed: ['investigating', 'implementing', 'rolled_back'],
  rolled_back: ['implementing', 'accepted'],
};

export function canTransitionOptimizationRun(
  from: OptimizationRunState,
  to: OptimizationRunState
): boolean {
  return optimizationStateTransitions[from].includes(to);
}

export function requiresOptimizationConfirmation(
  risk: OptimizationRisk,
  changeClass?: z.infer<typeof livePromotionSchema>['changeClass']
): boolean {
  return (
    risk.level === 'high' ||
    risk.requiresUserConfirmation ||
    changeClass === 'dependency' ||
    changeClass === 'data-migration'
  );
}
