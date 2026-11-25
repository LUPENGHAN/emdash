import '@emdash/ui/style.css';
import '@renderer/index.css';
import { decodeResourceUri } from '@emdash/core/primitives/path/api';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { MarkdownDocumentPreview } from '@core/features/editor/browser/renderers/markdown-renderer';
import {
  importMarkdownImages,
  isSupportedImageFile,
} from '@core/features/editor/browser/task-editor/markdown-image-import';
import { usePaneScope } from '@core/features/workbench/api/browser/tabs/use-pane-scope';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { createTabRegistry } from '@core/primitives/workbench-shell/browser/tabs/core/tab-provider-registry';
import { PaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import { PaneStore } from '@core/primitives/workbench-shell/browser/tabs/pane-store';
import { keybindingDispatcher } from '@renderer/lib/keybindings/keybinding-dispatcher';

const mocks = vi.hoisted(() => ({
  readImageFile: vi.fn(),
}));

vi.mock('@core/features/workbench/api/browser/task-composition-context', () => ({
  useWorkspace: () => ({
    path: '/workspace',
    sshConnectionId: undefined,
  }),
}));

vi.mock('@core/features/files/api/browser/file-content', () => ({
  readImageFile: mocks.readImageFile,
}));

vi.mock('@core/primitives/external-links/browser', () => ({
  useMarkdownLinkOpener: (openWorkspaceLink: (href: string) => boolean) => openWorkspaceLink,
}));

const fileClient = vi.hoisted(() => ({
  exists: vi.fn(),
  createDirectory: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@core/features/files/api/browser/client', () => ({
  getFilesClient: async () => ({ fs: fileClient }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function PreviewPane({ pane, children }: { pane: PaneStore; children: ReactNode }) {
  const { attachRef, instance, isFocused } = usePaneScope('preview-pane', pane);
  return (
    <PaneContext.Provider
      value={{ paneId: 'preview-pane', pane, scopeInstance: instance, isFocusedPane: isFocused }}
    >
      <div ref={attachRef} className="h-full">
        <button type="button">预览工具栏</button>
        {children}
      </div>
    </PaneContext.Provider>
  );
}

describe('Markdown preview and image import', () => {
  let host: HTMLDivElement;
  let root: Root;
  let pane: PaneStore;
  let detachKeybindings: () => void;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '1200px';
    host.style.height = '720px';
    document.body.appendChild(host);
    root = createRoot(host);
    pane = new PaneStore(createTabRegistry([]), { viewId: 'preview-test' });
    detachKeybindings = keybindingDispatcher.attach(window);
    mocks.readImageFile.mockReset();
    fileClient.exists.mockReset();
    fileClient.createDirectory.mockReset();
    fileClient.upload.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    detachKeybindings();
    pane.dispose();
    host.remove();
  });

  async function renderPreview(content: string, documentKey = 'diff:guide') {
    await act(async () => {
      root.render(
        <PreviewPane pane={pane}>
          <MarkdownDocumentPreview
            content={content}
            containingFilePath="/workspace/docs/guide.md"
            documentKey={documentKey}
          />
        </PreviewPane>
      );
    });
  }

  it('centers Markdown, exposes the outline, and resolves a relative image', async () => {
    mocks.readImageFile.mockResolvedValue({
      success: true,
      data: { dataUrl: 'data:image/png;base64,cGl4ZWw=', truncated: false },
    });

    await renderPreview('# 标题\n\n## 章节\n\n![示例](./guide.assets/example.png)');

    await vi.waitFor(() => {
      expect(host.querySelector('nav[aria-label="大纲"]')).not.toBeNull();
      expect(host.querySelector('img[alt="示例"]')?.getAttribute('src')).toBe(
        'data:image/png;base64,cGl4ZWw='
      );
    });

    const article = host.querySelector('.mx-auto.max-w-3xl');
    expect(article).not.toBeNull();
    expect(host.querySelector('[role="region"][aria-label="Markdown 预览"]')).not.toBeNull();
    const imageRef = mocks.readImageFile.mock.calls[0]?.[0];
    expect(imageRef.path.segments.join('/')).toBe('workspace/docs/guide.assets/example.png');
  });

  it('finds rendered text from the pane shortcut, jumps to the next match, and clears on Escape', async () => {
    const filler = Array.from({ length: 32 }, (_, i) => `段落 ${i}`).join('\n\n');
    await renderPreview(`# 文档\n\n配置 **C++**\n\n${filler}\n\n配置 C++`);
    const region = page.getByRole('region', { name: 'Markdown 预览' });
    const toolbar = host.querySelector('button')!;
    const find = page.getByRole('searchbox', { name: '查找关键字' });
    const onMac = detectPlatformContext().os === 'mac';
    toolbar.focus();
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      code: 'KeyF',
      bubbles: true,
      cancelable: true,
      metaKey: onMac,
      ctrlKey: !onMac,
    });
    await act(async () => toolbar.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    await expect.element(find).toHaveFocus();

    await act(async () => find.fill('配置 c++'));
    await expect.element(page.getByRole('status')).toHaveTextContent('1/2');
    const highlights = CSS.highlights.get('emdash-markdown-match');
    expect(Array.from(highlights ?? [], (range) => range.toString())).toEqual([
      '配置 C++',
      '配置 C++',
    ]);
    await act(async () => userEvent.keyboard('{Enter}'));
    await expect.element(page.getByRole('status')).toHaveTextContent('2/2');
    expect(region.element().scrollTop).toBeGreaterThan(0);
    await act(async () => userEvent.keyboard('{Shift>}{Enter}{/Shift}'));
    await expect.element(page.getByRole('status')).toHaveTextContent('1/2');

    await act(async () => userEvent.keyboard('{Escape}'));
    await expect.element(find).not.toBeInTheDocument();
    await expect.element(region).toHaveFocus();
    expect(CSS.highlights.has('emdash-markdown-match')).toBe(false);
  });

  it('refreshes matches when the content updates and closes when switching documents', async () => {
    await renderPreview('# 初始\n\n关键词');
    await act(async () => page.getByRole('button', { name: '在 Markdown 预览中查找' }).click());
    const find = page.getByRole('searchbox', { name: '查找关键字' });
    await act(async () => find.fill('关键词'));
    await expect.element(page.getByRole('status')).toHaveTextContent('1/1');
    await renderPreview('# 更新\n\n另一段正文');
    await expect.element(page.getByRole('status')).toHaveTextContent('无匹配');
    await renderPreview('# 另一份文档', 'second-document');
    await expect.element(find).not.toBeInTheDocument();
    expect(CSS.highlights.has('emdash-markdown-match')).toBe(false);
  });

  it('creates a document asset directory, avoids collisions, and returns a relative link', async () => {
    fileClient.exists
      .mockResolvedValueOnce({ success: true, data: { exists: false } })
      .mockResolvedValueOnce({ success: true, data: { exists: true } })
      .mockResolvedValueOnce({ success: true, data: { exists: false } });
    fileClient.createDirectory.mockResolvedValue({ success: true, data: undefined });
    fileClient.upload.mockResolvedValue({ success: true, data: undefined });

    const file = new File(['image'], '架构 图.PNG', { type: 'image/png' });
    const imported = await importMarkdownImages({
      documentPath: '/workspace/docs/guide.md',
      files: [file],
    });

    expect(imported).toEqual([
      {
        path: '/workspace/docs/guide.assets/架构-图-2.png',
        markdown: '![架构 图](./guide.assets/架构-图-2.png)',
      },
    ]);
    expect(fileClient.createDirectory).toHaveBeenCalledOnce();
    expect(fileClient.upload).toHaveBeenCalledOnce();

    const uploadUri = fileClient.upload.mock.calls[0]?.[0].uri;
    const decoded = decodeResourceUri(uploadUri);
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(decoded.data.path.segments.join('/')).toBe(
        'workspace/docs/guide.assets/架构-图-2.png'
      );
    }
  });

  it('recognizes Finder image drops even when the MIME type is missing', () => {
    expect(isSupportedImageFile({ name: '屏幕快照.PNG', type: '' })).toBe(true);
    expect(isSupportedImageFile({ name: 'notes.txt', type: '' })).toBe(false);
  });
});
