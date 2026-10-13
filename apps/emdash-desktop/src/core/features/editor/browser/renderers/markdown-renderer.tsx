import { Markdown, type MarkdownHeading } from '@emdash/ui/react/components';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { resolveWorkspaceResourcePath } from '@core/features/editor/api/browser/renderers/workspace-resource-path';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { readImageFile } from '@core/features/files/api/browser/file-content';
import { useWorkspace } from '@core/features/workbench/api/browser/task-composition-context';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import { useMarkdownLinkOpener } from '@core/primitives/external-links/browser';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

interface MarkdownEditorRendererProps {
  tab: FileTabResource;
}

/**
 * Renders a markdown file as a formatted preview.
 * The source/preview toggle lives in the FileContent container above this component.
 */
export const MarkdownEditorRenderer = observer(function MarkdownEditorRenderer({
  tab,
}: MarkdownEditorRendererProps) {
  const workspace = useWorkspace();
  const workspacePath = workspace.path;
  const { pane, paneId } = usePaneContext();

  // Reading bufferVersion creates a MobX tracking dependency so this observer
  // component re-renders whenever the buffer content changes or is first populated.
  void tab.bufferVersion;
  const content = tab.bufferText();

  const resolveImage = useCallback(
    async (src: string): Promise<string | null> => {
      const imagePath = resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: tab.path,
        resourcePath: src,
      });
      if (!imagePath) return null;
      const result = await readImageFile(
        hostFileRefFromNativePath(imagePath, workspace.sshConnectionId)
      );
      return result.success && !result.data.truncated ? result.data.dataUrl : null;
    },
    [workspace.sshConnectionId, workspacePath, tab.path]
  );

  const openWorkspaceLink = useCallback(
    (href: string): boolean => {
      const target = resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: tab.path,
        resourcePath: href,
      });
      if (!target) return false;
      pane.open('file', { path: target }, { preview: false });
      return true;
    },
    [workspacePath, tab.path, pane]
  );

  const openLink = useMarkdownLinkOpener(openWorkspaceLink);
  const headingPrefix = useMemo(
    () => headingIdPrefix(`${paneId}\0${tab.path}`),
    [paneId, tab.path]
  );
  const [allHeadings, setAllHeadings] = useState<MarkdownHeading[]>([]);
  const headings = useMemo(
    () => allHeadings.filter((heading) => heading.depth <= 3),
    [allHeadings]
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const outlineCollapsed = useSyncExternalStore(subscribeOutlineCollapsed, readOutlineCollapsed);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || headings.length === 0) return;
    const elements = headings.flatMap((heading) => {
      const element = root.querySelector(`#${CSS.escape(heading.id)}`);
      return element instanceof HTMLElement ? [element] : [];
    });
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const id = visible[0]?.target.id;
        if (id) setActiveId(id);
      },
      { root, rootMargin: '0px 0px -65% 0px', threshold: [0, 1] }
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [headings]);

  const scrollToHeading = useCallback((id: string): boolean => {
    const target = scrollRef.current?.querySelector(`#${CSS.escape(id)}`);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'start' });
    return true;
  }, []);

  const handleLink = useCallback(
    (href: string): boolean | void => {
      if (!href.startsWith('#')) return openLink(href);
      const fragment = safeDecode(href.slice(1));
      if (!scrollToHeading(`${headingPrefix}${fragment}`)) {
        scrollToHeading(`${headingPrefix}${fragment.toLowerCase()}`);
      }
      return true;
    },
    [openLink, scrollToHeading, headingPrefix]
  );

  return (
    // Sized by the pane, not the window: a narrow split hides the outline.
    <div className="@container flex h-full min-h-0 bg-(--em-surface)">
      {/* File content: the interface translation leaves it (and its headings) alone. */}
      <div
        ref={scrollRef}
        translate="no"
        className="relative h-full min-w-0 flex-1 overflow-y-auto"
      >
        <Markdown
          content={content}
          variant="full"
          className="w-full max-w-3xl px-8 py-8"
          resolveImage={resolveImage}
          onOpenLink={handleLink}
          headingIdPrefix={headingPrefix}
          onHeadings={setAllHeadings}
        />
      </div>
      {headings.length > 0 ? (
        <MarkdownOutline
          headings={headings}
          activeId={activeId}
          collapsed={outlineCollapsed}
          onSelect={scrollToHeading}
        />
      ) : null}
    </div>
  );
});

function MarkdownOutline({
  headings,
  activeId,
  collapsed,
  onSelect,
}: {
  headings: MarkdownHeading[];
  activeId: string | null;
  collapsed: boolean;
  onSelect: (id: string) => void;
}) {
  if (collapsed) {
    return (
      <div className="hidden w-8 shrink-0 justify-center border-l border-border pt-2 @3xl:flex">
        <button
          type="button"
          aria-label="Show outline"
          title="Show outline"
          className="hover:bg-muted flex size-6 items-center justify-center rounded text-foreground-muted hover:text-foreground"
          onClick={() => writeOutlineCollapsed(false)}
        >
          <PanelRightOpen className="size-3.5" />
        </button>
      </div>
    );
  }
  return (
    <nav
      aria-label="Outline"
      className="hidden w-56 shrink-0 flex-col border-l border-border pr-3 pl-3 @3xl:flex"
    >
      <div className="flex items-center justify-between py-2 pl-2">
        <span className="text-xs font-medium text-foreground-muted">Outline</span>
        <button
          type="button"
          aria-label="Hide outline"
          title="Hide outline"
          className="hover:bg-muted flex size-6 items-center justify-center rounded text-foreground-muted hover:text-foreground"
          onClick={() => writeOutlineCollapsed(true)}
        >
          <PanelRightClose className="size-3.5" />
        </button>
      </div>
      <ul translate="no" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-6">
        {headings.map((heading) => (
          <li key={heading.id}>
            <button
              type="button"
              className={`hover:bg-muted block w-full truncate rounded px-2 py-1 text-left text-xs ${
                heading.depth === 2 ? 'pl-4' : heading.depth === 3 ? 'pl-6' : ''
              } ${activeId === heading.id ? 'text-foreground' : 'text-foreground-muted'}`}
              onClick={() => onSelect(heading.id)}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const OUTLINE_COLLAPSED_KEY = 'emdash:markdown-outline-collapsed';
const outlineListeners = new Set<() => void>();
let outlineCollapsedState: boolean | undefined;

function readOutlineCollapsed(): boolean {
  if (outlineCollapsedState === undefined) {
    try {
      outlineCollapsedState = localStorage.getItem(OUTLINE_COLLAPSED_KEY) === 'true';
    } catch {
      outlineCollapsedState = false;
    }
  }
  return outlineCollapsedState;
}

function writeOutlineCollapsed(collapsed: boolean): void {
  outlineCollapsedState = collapsed;
  try {
    localStorage.setItem(OUTLINE_COLLAPSED_KEY, String(collapsed));
  } catch {
    // localStorage may be unavailable
  }
  for (const listener of outlineListeners) listener();
}

function subscribeOutlineCollapsed(listener: () => void): () => void {
  outlineListeners.add(listener);
  return () => outlineListeners.delete(listener);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function headingIdPrefix(key: string): string {
  let hash = 0;
  for (const char of key) hash = (Math.imul(31, hash) + char.charCodeAt(0)) >>> 0;
  return `md-${hash.toString(36)}-`;
}
