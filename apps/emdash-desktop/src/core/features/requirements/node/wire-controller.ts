import { createController, type Controller } from '@emdash/wire/rpc';
import { requirementsContract } from '../api/contract';
import { requirementsEvents } from './event-host';
import type { RequirementsService } from './requirements-service';

export function createRequirementsWireController(service: RequirementsService): Controller {
  return createController(requirementsContract, {
    events: requirementsEvents,
    list: ({ projectId }) => service.list(projectId),
    // The window always writes as the user; only the MCP server adds as an agent.
    add: ({ projectId, title, detail }) =>
      service.add(projectId, { title, detail }, { kind: 'user' }),
    update: ({ projectId, id, ...changes }) => service.update(projectId, id, changes),
    remove: ({ projectId, id }) => service.remove(projectId, id),
  });
}
