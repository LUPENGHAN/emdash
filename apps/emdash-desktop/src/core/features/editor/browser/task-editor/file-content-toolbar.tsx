import { Button, ToggleGroup } from '@emdash/ui/react/primitives';
import { ImagePlus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useRef, type ChangeEvent } from 'react';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { useWorkspace } from '@core/features/workbench/api/browser/task-composition-context';
import { relativeToWorkspace } from '@core/features/workspaces/api/browser/workspace-path';

interface FileContentToolbarProps {
  tab: FileTabResource;
  canToggle: boolean;
  importingImages: boolean;
  onImportImages: (files: readonly File[]) => void;
}

/** Top bar shown on every file tab: file path on the left, Raw/Preview tabs on the right. */
export const FileContentToolbar = observer(function FileContentToolbar({
  tab,
  canToggle,
  importingImages,
  onImportImages,
}: FileContentToolbarProps) {
  const workspace = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  const displayPath = tab.inWorkspace
    ? relativeToWorkspace(workspace.path, tab.path)
    : tab.displayPath;
  const handleImport = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    onImportImages(files);
  };

  return (
    <div className="flex h-[41px] shrink-0 items-center justify-between gap-2 border-b border-border bg-(--em-surface) px-2">
      <span
        className="min-w-0 flex-1 truncate text-xs text-foreground-passive"
        title={tab.displayPath}
      >
        {displayPath}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {tab.fileKind === 'markdown' && !tab.readOnly ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-label="选择要导入的图片"
              onChange={handleImport}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={importingImages}
              onClick={() => inputRef.current?.click()}
              title="将图片复制到文档资源目录并插入相对链接"
            >
              <ImagePlus className="size-3.5" />
              {importingImages ? '导入中…' : '导入图片'}
            </Button>
          </>
        ) : null}
        {canToggle && (
          <ToggleGroup.Root
            multiple={false}
            value={[tab.viewMode]}
            onValueChange={([value]) => {
              if (value === 'preview' || value === 'source') tab.setViewMode(value);
            }}
          >
            <ToggleGroup.Item size="sm" value="source" className="text-xs">
              源码
            </ToggleGroup.Item>
            <ToggleGroup.Item size="sm" value="preview" className="text-xs">
              预览
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
      </div>
    </div>
  );
});
