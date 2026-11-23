import { Button, Checkbox, Dialog } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { getCoordinationClient } from '../api/browser/client';
import type { CoordinatorPermanentDeleteOptions } from '../api/types';

export type DeleteMainAgentModalArgs = {
  id: string;
  name: string;
};

export type DeleteMainAgentModalResult = CoordinatorPermanentDeleteOptions;

export function DeleteMainAgentModal({ id, name }: DeleteMainAgentModalArgs) {
  const { complete, dismiss } = useModalController('deleteMainAgentModal');
  const [deleteChildren, setDeleteChildren] = useState(true);
  const [deleteChildBranches, setDeleteChildBranches] = useState(false);
  const {
    data: preview,
    error,
    isError,
    isPending,
  } = useQuery({
    queryKey: ['mainAgentPermanentDeletePreview', id],
    queryFn: async () => (await getCoordinationClient()).permanentDeletePreview({ id }),
    staleTime: 0,
  });

  const allTasks = preview
    ? [...(preview.mainTask ? [preview.mainTask] : []), ...preview.childTasks]
    : [];
  const deletedTasks = preview
    ? [
        ...(preview.mainTask ? [preview.mainTask] : []),
        ...(deleteChildren ? preview.childTasks : []),
      ]
    : [];
  const dirtyTasks = deletedTasks.filter((task) => task.hasUncommittedChanges);
  const unpushedTasks = deletedTasks.filter((task) => (task.unpushedCommits ?? 0) > 0);
  const unreachableTasks = deletedTasks.filter((task) => !task.hostReachable);
  const childBranchCount =
    preview?.childTasks.filter((task) => task.hasDeletableBranch).length ?? 0;

  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>永久删除主任务工作区</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="flex flex-col gap-4 pt-0">
        <p className="text-sm text-foreground-muted">
          “{name}”的主任务、对话、工作区文档 worktree 和文档分支将被永久删除，无法恢复。
          关联项目的需求、决策、项目记忆和全局记忆会保留。
        </p>

        {preview && (
          <div className="rounded-md border border-border px-3 py-2 text-sm">
            <p className="font-medium">本次清理</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-foreground-muted">
              <li>主任务工作区和全部对话</li>
              <li>
                {preview.mainTask?.hasWorktree
                  ? '工作区文档 worktree 和文档分支'
                  : '工作区文档记录'}
              </li>
              <li>
                {deleteChildren
                  ? `${preview.childTasks.length} 个真实子任务及其对话和 worktree`
                  : `${preview.childTasks.length} 个真实子任务将解除关联并保留`}
              </li>
              {preview.staleTaskCount > 0 && (
                <li>{preview.staleTaskCount} 条已不存在的历史任务引用</li>
              )}
            </ul>
          </div>
        )}

        {(preview?.childTasks.length ?? 0) > 0 && (
          <div className="flex flex-col gap-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                checked={deleteChildren}
                onCheckedChange={(checked) => {
                  setDeleteChildren(Boolean(checked));
                  if (!checked) setDeleteChildBranches(false);
                }}
              />
              <span>同时永久删除 {preview!.childTasks.length} 个子任务、对话和 worktree</span>
            </label>
            {childBranchCount > 0 && (
              <label
                className="flex cursor-pointer items-start gap-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                aria-disabled={!deleteChildren}
              >
                <Checkbox
                  checked={deleteChildren && deleteChildBranches}
                  disabled={!deleteChildren}
                  onCheckedChange={(checked) => setDeleteChildBranches(Boolean(checked))}
                />
                <span>同时删除 {childBranchCount} 个由 Emdash 创建的子任务分支</span>
              </label>
            )}
          </div>
        )}

        {(dirtyTasks.length > 0 || unpushedTasks.length > 0 || unreachableTasks.length > 0) && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md bg-background-warning px-3 py-2 text-xs text-foreground-warning"
          >
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <div className="space-y-1">
              {dirtyTasks.length > 0 && <p>{dirtyTasks.length} 个 worktree 有未提交修改。</p>}
              {unpushedTasks.length > 0 && <p>{unpushedTasks.length} 个任务有未推送提交。</p>}
              {unreachableTasks.length > 0 && (
                <p>
                  {unreachableTasks.length} 个 worktree
                  当前不可访问；任务记录会删除，文件需要恢复连接后从工作区列表清理。
                </p>
              )}
            </div>
          </div>
        )}

        {!isPending && !isError && allTasks.length === 0 && (
          <p className="text-xs text-foreground-muted">没有发现仍存在的任务或 worktree 资产。</p>
        )}

        {isError && (
          <div
            role="alert"
            className="rounded-md bg-background-destructive px-3 py-2 text-xs text-foreground-destructive"
          >
            无法检查删除范围：{error instanceof Error ? error.message : '未知错误'}
          </div>
        )}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" onClick={dismiss} autoFocus>
          取消
        </Button>
        <ConfirmButton
          variant="destructive"
          disabled={isPending || !preview}
          onClick={() => complete({ deleteChildren, deleteChildBranches })}
        >
          {isPending ? '正在检查…' : '永久删除'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
}

export const deleteMainAgentModal = defineModal<DeleteMainAgentModalResult>()({
  id: 'deleteMainAgentModal',
  component: DeleteMainAgentModal,
  size: 'sm',
});
