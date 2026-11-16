import { describe, expect, it } from 'vitest';
import type { AgentCaller } from '@core/features/agent-control/api';
import type { Coordinator } from '../api/types';
import { coordinatorPrincipal, mayAccessProject, mayAccessTask } from './coordinator-access';

function main(id = 'a'): Coordinator {
  return {
    version: '9',
    id,
    kind: 'project',
    name: 'Main',
    projectId: id,
    projectIds: [id],
    taskId: `main-${id}`,
    conversationId: `conversation-${id}`,
    primary: {},
    delegationDefaults: {},
    tasks: {},
    events: [],
  };
}
function caller(record: Coordinator, taskId = record.taskId): AgentCaller {
  return {
    conversationId: taskId === record.taskId ? record.conversationId : `conversation-${taskId}`,
    projectId: record.tasks[taskId]?.projectId ?? record.projectId,
    taskId,
    providerId: 'claude',
    title: 'Caller',
    cwd: null,
  };
}
function worker(
  record: Coordinator,
  id: string,
  projectId: string,
  grantedProjectIds: string[] = []
) {
  record.tasks[id] = {
    taskId: id,
    projectId,
    name: id,
    state: 'assigned',
    resultVersion: 0,
    submissions: {},
    grantedProjectIds,
  };
  return caller(record, id);
}
describe('coordinator access', () => {
  it('lets a main agent discover and delegate across projects without changing its linked context', () => {
    const record = main();
    const actor = caller(record);
    expect(mayAccessProject(actor, coordinatorPrincipal(actor, [record]), 'b', 'delegate')).toBe(
      true
    );
    expect(record.projectIds).toEqual(['a']);
    record.projectAccess = { mode: 'selected', projectIds: ['a'] };
    record.projectIds.push('b');
    expect(mayAccessProject(actor, coordinatorPrincipal(actor, [record]), 'b', 'read')).toBe(false);
  });
  it('limits workers to their own task until project access is explicitly granted', () => {
    const record = main();
    const actor = worker(record, 'worker', 'b');
    const principal = coordinatorPrincipal(actor, [record]);
    expect(mayAccessProject(actor, principal, 'b', 'read')).toBe(true);
    expect(mayAccessProject(actor, principal, 'b', 'delegate')).toBe(false);
    expect(mayAccessTask(actor, [record], { id: 'peer', projectId: 'b' }, 'read')).toBe(false);
    expect(mayAccessTask(actor, [record], { id: 'worker', projectId: 'b' }, 'control')).toBe(true);
    record.tasks.worker.grantedProjectIds = ['c'];
    expect(mayAccessProject(actor, principal, 'c', 'delegate')).toBe(true);
    expect(mayAccessTask(actor, [record], { id: 'unowned', projectId: 'c' }, 'control')).toBe(true);
  });
  it('caps worker grants when its main agent project permissions are narrowed', () => {
    const record = main();
    const actor = worker(record, 'worker', 'b', ['c']);
    record.projectAccess = { mode: 'selected', projectIds: ['b'] };
    expect(mayAccessProject(actor, coordinatorPrincipal(actor, [record]), 'c', 'delegate')).toBe(
      false
    );
    expect(mayAccessTask(actor, [record], { id: 'worker', projectId: 'b' }, 'control')).toBe(true);
  });
  it('allows reading authorized foreign tasks but requires explicit ownership transfer before controlling them', () => {
    const record = main();
    const other = main('b');
    const target = worker(other, 'foreign', 'b');
    const actor = caller(record);
    expect(
      mayAccessTask(actor, [record, other], { id: target.taskId, projectId: 'b' }, 'read')
    ).toBe(true);
    expect(
      mayAccessTask(actor, [record, other], { id: target.taskId, projectId: 'b' }, 'control')
    ).toBe(false);
    expect(
      mayAccessTask(actor, [record, other], { id: 'unowned', projectId: 'b' }, 'control')
    ).toBe(false);
  });
  it('keeps ordinary agent scope in its project and prevents replaced main conversations from delegating', () => {
    const record = main();
    const actor = { ...caller(record), taskId: 'ordinary' };
    expect(mayAccessProject(actor, coordinatorPrincipal(actor, [record]), 'a', 'delegate')).toBe(
      true
    );
    expect(mayAccessProject(actor, coordinatorPrincipal(actor, [record]), 'b', 'delegate')).toBe(
      false
    );
    const replaced = { ...caller(record), conversationId: 'replaced' };
    expect(
      mayAccessProject(replaced, coordinatorPrincipal(replaced, [record]), 'a', 'delegate')
    ).toBe(false);
  });
});
