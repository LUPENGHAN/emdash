import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import { z } from 'zod';
import { defineMemento } from '@core/primitives/mementos/api';
import { appSubject } from '@core/primitives/subjects/api';

const workbenchSidebarV1Schema = z.object({
  version: z.literal('1'),
  expandedProjectIds: z.array(z.string()),
  projectOrder: z.array(z.string()),
  taskOrderByProject: z.record(z.string(), z.array(z.string())),
  taskSortBy: z.enum(['created-at', 'updated-at']),
});

const workbenchSidebarV2Schema = workbenchSidebarV1Schema.extend({
  version: z.literal('2'),
  folderOrder: z.array(z.string()),
  archivedExpanded: z.boolean(),
});

const workbenchSidebarV3Schema = workbenchSidebarV2Schema.extend({
  version: z.literal('3'),
  collapsedFolderIds: z.array(z.string()),
});

export const workbenchSidebarSchema = defineVersionedSchema()
  .initial('1', workbenchSidebarV1Schema)
  .version('2', workbenchSidebarV2Schema, (previous) => {
    const { version: _version, ...rest } = previous;
    return {
      ...rest,
      version: '2' as const,
      folderOrder: [],
      archivedExpanded: false,
    };
  })
  .version('3', workbenchSidebarV3Schema, (previous) => {
    const { version: _version, ...rest } = previous;
    return {
      ...rest,
      version: '3' as const,
      collapsedFolderIds: [],
    };
  })
  .build();

export type WorkbenchSidebarState = typeof workbenchSidebarSchema.Type;

export const workbenchSidebarMemento = defineMemento({
  id: 'workbench.sidebar',
  subject: appSubject,
  schema: workbenchSidebarSchema,
  default: {
    version: '3' as const,
    expandedProjectIds: [],
    projectOrder: [],
    folderOrder: [],
    archivedExpanded: false,
    collapsedFolderIds: [],
    taskOrderByProject: {},
    taskSortBy: 'created-at' as const,
  },
});

const workbenchPanelLayoutsV1Schema = z.object({
  version: z.literal('1'),
  layouts: z.record(z.string(), z.string()),
});

export const workbenchPanelLayoutsSchema = defineVersionedSchema()
  .initial('1', workbenchPanelLayoutsV1Schema)
  .build();
export type WorkbenchPanelLayoutsState = typeof workbenchPanelLayoutsSchema.Type;

export const workbenchPanelLayoutsMemento = defineMemento({
  id: 'workbench.panel-layouts',
  subject: appSubject,
  schema: workbenchPanelLayoutsSchema,
  default: {
    version: '1' as const,
    layouts: {},
  },
});

// The navigation and history mementos moved into the navigation primitive:
// @core/primitives/navigation/api/mementos.
