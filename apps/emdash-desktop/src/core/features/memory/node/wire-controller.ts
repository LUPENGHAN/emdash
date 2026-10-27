import { createController, type Controller } from '@emdash/wire/rpc';
import { memoryContract } from '../api/contract';
import type { MemoryScope } from '../api/types';
import { memoryEvents } from './event-host';
import type { MemoryService } from './memory-service';

function scopeFrom(input: { scope: 'project' | 'global'; projectId?: string }): MemoryScope {
  if (input.scope === 'global') return { kind: 'global' };
  if (!input.projectId) throw new Error('Project decisions need a project');
  return { kind: 'project', projectId: input.projectId };
}

export function createMemoryWireController(service: MemoryService): Controller {
  return createController(memoryContract, {
    events: memoryEvents,
    list: (input) => service.list(scopeFrom(input)),
    get: (input) => service.get(scopeFrom(input), input.id),
    // The window always writes as the user; only the MCP server adds as an agent.
    add: (input) =>
      service.add(scopeFrom(input), { title: input.title, detail: input.detail }, { kind: 'user' }),
    update: (input) =>
      service.update(scopeFrom(input), input.id, { title: input.title, detail: input.detail }),
    remove: (input) => service.remove(scopeFrom(input), input.id),
  });
}
