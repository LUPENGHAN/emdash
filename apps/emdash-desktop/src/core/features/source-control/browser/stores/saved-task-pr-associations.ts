import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import type { TaskPullRequestRecord } from '../../api/task-pull-requests';

/** A saved receipt refers to its explicit target, independently of Project remote defaults. */
export async function savedTaskPrAssociations(input: {
  taskId: string;
  workspaceId: string;
  branch: string;
  records: readonly TaskPullRequestRecord[];
  byUrl(repositoryUrl: string, url: string): Promise<PullRequest | null>;
}): Promise<PullRequest[]> {
  const associated = new Map<string, PullRequest>();
  for (const record of input.records) {
    if (
      !record.result ||
      record.plan.taskId !== input.taskId ||
      record.plan.workspaceId !== input.workspaceId ||
      record.plan.sourceRef !== `refs/heads/${input.branch}` ||
      associated.has(record.result.url)
    )
      continue;
    const pr = await input.byUrl(record.plan.repositoryUrl, record.result.url);
    if (!pr) throw new Error('The saved task PR receipt is not available in the platform cache.');
    associated.set(pr.url, pr);
  }
  return [...associated.values()];
}
