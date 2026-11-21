import type { AgentCaller } from '@core/features/agent-control/api';
import type { AssignedTask, Coordinator } from '../api/types';

export type CoordinatorPrincipal =
  | { kind: 'main'; coordinator: Coordinator }
  | { kind: 'worker'; coordinator: Coordinator; assignment: AssignedTask }
  | { kind: 'ordinary' };

export function coordinatorPrincipal(
  caller: AgentCaller,
  records: Coordinator[]
): CoordinatorPrincipal {
  const main = records.find((record) => record.taskId === caller.taskId);
  if (main) return { kind: 'main', coordinator: main };
  const owner = records.find((record) => record.tasks[caller.taskId]);
  return owner
    ? { kind: 'worker', coordinator: owner, assignment: owner.tasks[caller.taskId] }
    : { kind: 'ordinary' };
}

function coordinatorAllows(record: Coordinator, projectId: string): boolean {
  return (
    record.projectAccess?.mode !== 'selected' || record.projectAccess.projectIds.includes(projectId)
  );
}

/** Linked projects organize context. Only projectAccess and explicit worker grants confer access. */
export function mayAccessProject(
  caller: AgentCaller,
  principal: CoordinatorPrincipal,
  projectId: string,
  intent: 'read' | 'delegate'
): boolean {
  if (principal.kind === 'ordinary') return caller.projectId === projectId;
  if (principal.kind === 'main') {
    if (intent === 'read' && projectId === caller.projectId) return true;
    return coordinatorAllows(principal.coordinator, projectId);
  }
  if (intent === 'read' && projectId === caller.projectId) return true;
  return (
    !!principal.assignment.grantedProjectIds?.includes(projectId) &&
    coordinatorAllows(principal.coordinator, projectId)
  );
}

export function mayAccessTask(
  caller: AgentCaller,
  records: Coordinator[],
  target: { id: string; projectId: string },
  intent: 'read' | 'control'
): boolean {
  if (target.id === caller.taskId) return true;
  const principal = coordinatorPrincipal(caller, records);
  const owner = records.find((record) => record.taskId === target.id || record.tasks[target.id]);
  if (intent === 'read') {
    if (principal.kind === 'worker')
      return (
        !!principal.assignment.grantedProjectIds?.includes(target.projectId) &&
        mayAccessProject(caller, principal, target.projectId, 'read')
      );
    return mayAccessProject(caller, principal, target.projectId, 'read');
  }
  if (principal.kind === 'ordinary') return !owner && target.projectId === caller.projectId;
  if (!mayAccessProject(caller, principal, target.projectId, 'delegate')) return false;
  if (principal.kind === 'main') return owner?.id === principal.coordinator.id;
  return !owner || owner.id === principal.coordinator.id;
}
