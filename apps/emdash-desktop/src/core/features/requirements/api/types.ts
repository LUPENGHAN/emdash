import { z } from 'zod';

export const REQUIREMENT_TITLE_MAX = 200;
export const REQUIREMENT_DETAIL_MAX = 10_000;
/** A project's list stops growing here, so one KV row stays small. */
export const REQUIREMENTS_PER_PROJECT_MAX = 500;

export const requirementSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({
    kind: z.literal('agent'),
    providerId: z.string(),
    conversationId: z.string(),
    taskId: z.string(),
  }),
]);

export const requirementSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(REQUIREMENT_TITLE_MAX),
  detail: z.string().max(REQUIREMENT_DETAIL_MAX).optional(),
  status: z.enum(['open', 'done']),
  source: requirementSourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const projectRequirementsSchema = z.object({
  version: z.literal(1),
  items: z.array(requirementSchema),
});

export type RequirementSource = z.infer<typeof requirementSourceSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type ProjectRequirements = z.infer<typeof projectRequirementsSchema>;

export type RequirementsEvent = {
  projectId: string;
  /** Set when an agent added one, so the window can tell the user. */
  addedByAgent?: { title: string; providerId: string };
};

export type RequirementChanges = {
  title?: string;
  /** An empty string clears the detail. */
  detail?: string;
  status?: Requirement['status'];
};

/** What other features (agent control, project deletion) do with the lists. */
export type RequirementsOperations = {
  list(projectId: string): Promise<Requirement[]>;
  add(
    projectId: string,
    input: { title: string; detail?: string },
    source: RequirementSource
  ): Promise<Requirement>;
  update(projectId: string, id: string, changes: RequirementChanges): Promise<Requirement>;
  removeProject(projectId: string): Promise<void>;
};
