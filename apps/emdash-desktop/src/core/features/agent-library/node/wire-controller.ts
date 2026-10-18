import { createController, type Controller } from '@emdash/wire/rpc';
import { agentLibraryContract } from '../api';
import type { AgentLibraryService } from './agent-library-service';

export function createAgentLibraryWireController(service: AgentLibraryService): Controller {
  return createController(agentLibraryContract, {
    scanAgentSkills: () => service.scanAgentSkills(),
    importAgentSkills: () => service.importAgentSkills(),
    takeOverAgentSkills: () => service.takeOverAgentSkills(),
    listSkillSources: () => service.listSkillSources(),
    checkSkillUpdates: () => service.checkSkillUpdates(),
    setSkillSource: ({ name, url }) => service.setSkillSource(name, url),
    updateSkill: ({ name, force }) => service.updateSkill(name, force),
    scanGitHubSkills: ({ url }) => service.scanGitHubSkills(url),
    installGitHubSkills: (input) => service.installGitHubSkills(input),
    checkMcpServer: ({ name }) => service.checkMcpServer(name),
    checkMcpHealth: ({ name }) => service.checkMcpHealth(name),
    effectiveFor: ({ projectId }) => service.effectiveFor(projectId),
  });
}
