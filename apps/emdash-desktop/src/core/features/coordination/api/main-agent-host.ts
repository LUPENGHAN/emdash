export { MAIN_AGENT_HOST_PROJECT_ID } from '@core/primitives/projects/api';
import { MAIN_AGENT_HOST_PROJECT_ID } from '@core/primitives/projects/api';

export function isMainAgentHostProject(projectId: string): boolean {
  return projectId === MAIN_AGENT_HOST_PROJECT_ID;
}
