export const MAIN_AGENT_HOST_PROJECT_ID = '__emdash_main_agent_host__';

export function isMainAgentHostProject(projectId: string): boolean {
  return projectId === MAIN_AGENT_HOST_PROJECT_ID;
}
