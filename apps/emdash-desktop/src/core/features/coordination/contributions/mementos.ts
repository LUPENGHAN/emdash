import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { taskSubject } from '@core/features/tasks/contributions/subject';
import { defineMemento } from '@core/primitives/mementos/api';

const coordinatorViewSchema = defineVersionedSchema()
  .initial(
    '1',
    z.object({
      version: z.literal('1'),
      tab: z.enum(['conversation', 'tasks', 'documents', 'settings']),
    })
  )
  .build();

export const coordinatorViewMemento = defineMemento({
  id: 'coordination.view',
  subject: taskSubject,
  schema: coordinatorViewSchema,
  default: { version: '1' as const, tab: 'conversation' as const },
  retention: { tier: 'transient' },
});
