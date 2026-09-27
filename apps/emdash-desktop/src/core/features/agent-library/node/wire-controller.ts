import { createController, type Controller } from '@emdash/wire/rpc';
import { agentLibraryContract } from '../api';
import type { AgentLibraryService } from './agent-library-service';

export function createAgentLibraryWireController(service: AgentLibraryService): Controller {
  return createController(agentLibraryContract, {
    scanAgentSkills: () => service.scanAgentSkills(),
    importAgentSkills: () => service.importAgentSkills(),
    takeOverAgentSkills: () => service.takeOverAgentSkills(),
    effectiveFor: ({ projectId }) => service.effectiveFor(projectId),
  });
}
