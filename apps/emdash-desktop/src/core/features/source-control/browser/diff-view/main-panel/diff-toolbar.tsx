import { MicroLabel, ToggleGroup } from '@emdash/ui/react/primitives';
import { AlignJustify, BookOpenText, Columns2, FileCode2, FileDiff } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import type { DiffTabResource } from '../stores/diff-tab-resource';

interface DiffToolbarProps {
  tab: DiffTabResource;
}

export const DiffToolbar = observer(function DiffToolbar({ tab }: DiffToolbarProps) {
  const diffView = useTaskComposition().diffView;
  const diffStyle = diffView?.diffStyle;
  const canPreview = tab.renderer.kind === 'text' && tab.renderer.previewKind !== undefined;

  const diffSourceLabel = (() => {
    if (tab.diffGroup === 'staged') return 'Staged';
    if (tab.diffGroup === 'disk') return 'Changed';
    if (tab.diffGroup === 'pr') return 'PR';
    if (tab.diffGroup === 'git') return 'Git';
    return undefined;
  })();

  if (!diffView || !diffStyle) return null;

  return (
    <div className="flex h-[41px] items-center justify-between gap-2 border-b border-border bg-(--em-surface) px-2">
      <div className="flex items-center gap-3">
        {diffSourceLabel && <MicroLabel>{diffSourceLabel}</MicroLabel>}
      </div>
      <div className="flex items-center gap-2">
        {canPreview && (
          <ToggleGroup.Root
            multiple={false}
            value={[tab.viewMode]}
            aria-label="文件显示模式"
            onValueChange={([value]) => {
              if (value === 'diff' || value === 'source' || value === 'preview') {
                tab.setViewMode(value);
              }
            }}
          >
            <ToggleGroup.Item
              size="sm"
              value="diff"
              className="min-w-16 gap-1 text-xs"
              title="查看文件改动"
            >
              <FileDiff className="size-3.5" />
              差异
            </ToggleGroup.Item>
            <ToggleGroup.Item
              size="sm"
              value="source"
              className="min-w-16 gap-1 text-xs"
              title="浏览修改后的原始内容"
            >
              <FileCode2 className="size-3.5" />
              源码
            </ToggleGroup.Item>
            <ToggleGroup.Item
              size="sm"
              value="preview"
              className="min-w-16 gap-1 text-xs"
              title="浏览渲染后的文档"
            >
              <BookOpenText className="size-3.5" />
              浏览
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
        {tab.viewMode === 'diff' && (
          <ToggleGroup.Root
            multiple={false}
            value={[diffStyle]}
            onValueChange={([value]) => {
              if (value) {
                diffView.setDiffStyle(value as 'unified' | 'split');
              }
            }}
          >
            <ToggleGroup.Item size="sm" icon value="unified" aria-label="Unified diff">
              <AlignJustify className="h-3.5 w-3.5" />
            </ToggleGroup.Item>
            <ToggleGroup.Item size="sm" icon value="split" aria-label="Split diff">
              <Columns2 className="h-3.5 w-3.5" />
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
      </div>
    </div>
  );
});
