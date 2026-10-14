import { Markdown, type MarkdownHeading } from '@emdash/ui/react/components';
import { List, PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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
    // Sized by the pane, not the window: a narrow split floats the outline over the file.
    <div className="@container relative flex h-full min-h-0 bg-(--em-surface)">
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
        <>
          <MarkdownOutline
            headings={headings}
            activeId={activeId}
            collapsed={outlineCollapsed}
            onSelect={scrollToHeading}
          />
          <FloatingMarkdownOutline
            headings={headings}
            activeId={activeId}
            onSelect={scrollToHeading}
          />
        </>
      ) : null}
    </div>
  );
});

type OutlineProps = {
  headings: MarkdownHeading[];
  activeId: string | null;
  onSelect: (id: string) => void;
};

/** The outline beside the file, in a pane wide enough for both. */
function MarkdownOutline({ collapsed, ...props }: OutlineProps & { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div className="hidden w-8 shrink-0 justify-center border-l border-border pt-2 @2xl:flex">
        <OutlineButton label="Show outline" onClick={() => writeOutlineCollapsed(false)}>
          <PanelRightOpen className="size-3.5" />
        </OutlineButton>
      </div>
    );
  }
  return (
    <nav
      aria-label="Outline"
      className="hidden w-56 shrink-0 flex-col border-l border-border pr-3 pl-3 @2xl:flex"
    >
      <OutlineHeader>
        <OutlineButton label="Hide outline" onClick={() => writeOutlineCollapsed(true)}>
          <PanelRightClose className="size-3.5" />
        </OutlineButton>
      </OutlineHeader>
      <OutlineList {...props} />
    </nav>
  );
}

/** In a narrow pane: a button that opens the outline over the file. */
function FloatingMarkdownOutline({ onSelect, ...props }: OutlineProps) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="absolute top-2 right-4 @2xl:hidden">
        <OutlineButton label="Show outline" onClick={() => setOpen(true)}>
          <List className="size-3.5" />
        </OutlineButton>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 z-10 @2xl:hidden" onClick={() => setOpen(false)}>
      <nav
        aria-label="Outline"
        className="absolute top-0 right-0 bottom-0 flex w-56 max-w-[80%] flex-col border-l border-border bg-(--em-surface) pr-3 pl-3 shadow-lg"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <OutlineHeader>
          <OutlineButton label="Hide outline" onClick={() => setOpen(false)}>
            <X className="size-3.5" />
          </OutlineButton>
        </OutlineHeader>
        <OutlineList
          {...props}
          onSelect={(id) => {
            setOpen(false);
            onSelect(id);
          }}
        />
      </nav>
    </div>
  );
}

function OutlineHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 pl-2">
      <span className="text-xs font-medium text-foreground-muted">Outline</span>
      {children}
    </div>
  );
}

function OutlineButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="hover:bg-muted flex size-6 items-center justify-center rounded text-foreground-muted hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function OutlineList({ headings, activeId, onSelect }: OutlineProps) {
  return (
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
