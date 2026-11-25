import './markdown-preview-search.css';
import { Button, Input } from '@emdash/ui/react/primitives';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

const MATCH_HIGHLIGHT = 'emdash-markdown-match';
const ACTIVE_HIGHLIGHT = 'emdash-markdown-active-match';

export function MarkdownPreviewSearch({
  scrollRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { pane } = usePaneContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<TextIndex | null>(null);
  const [current, setCurrent] = useState(0);
  const matches = useMemo(() => (index && query ? findMatches(index, query) : []), [index, query]);
  const active = Math.min(current, Math.max(0, matches.length - 1));
  const activeMatch = matches[active];

  const openSearch = useCallback(() => {
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useLayoutEffect(() => pane.registerContentFinder(openSearch), [pane, openSearch]);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = scrollRef.current;
    if (!root) return;
    const updateIndex = () => setIndex(indexText(root));
    updateIndex();
    // Code highlighting and other Markdown content can finish rendering after the initial paint.
    const observer = new MutationObserver(updateIndex);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [open, scrollRef]);

  useLayoutEffect(() => addHighlight(MATCH_HIGHLIGHT, matches), [matches]);
  useLayoutEffect(() => {
    if (!activeMatch) return;
    const root = scrollRef.current;
    if (root) revealMatch(root, activeMatch);
    return addHighlight(ACTIVE_HIGHLIGHT, [activeMatch], 1);
  }, [activeMatch, scrollRef]);

  const step = (offset: number) => {
    if (matches.length) setCurrent((active + offset + matches.length) % matches.length);
  };
  const close = () => {
    setOpen(false);
    setQuery('');
    setIndex(null);
    setCurrent(0);
    scrollRef.current?.focus({ preventScroll: true });
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon
        className="absolute top-1 left-2 z-10 text-foreground-muted"
        aria-label="在 Markdown 预览中查找"
        title="在 Markdown 预览中查找"
        onClick={openSearch}
      >
        <Search className="size-3.5" />
      </Button>
    );
  }

  return (
    <div
      role="search"
      aria-label="Markdown 预览查找"
      className="relative z-20 flex shrink-0 items-center gap-1 border-b border-border bg-(--em-surface) p-1.5"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <Input
        ref={inputRef}
        value={query}
        type="search"
        aria-label="查找关键字"
        placeholder="在预览中查找"
        className="h-7 min-w-0 flex-1 text-xs"
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrent(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== 'Enter') return;
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }}
      />
      <span role="status" className="shrink-0 px-1 text-xs text-foreground-muted">
        {matches.length ? `${active + 1}/${matches.length}` : query ? '无匹配' : ''}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        icon
        aria-label="上一处匹配"
        title="上一处匹配"
        disabled={!matches.length}
        onClick={() => step(-1)}
      >
        <ChevronUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        icon
        aria-label="下一处匹配"
        title="下一处匹配"
        disabled={!matches.length}
        onClick={() => step(1)}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        icon
        aria-label="关闭查找"
        title="关闭查找"
        onClick={close}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

type TextIndex = {
  text: string;
  parts: Array<{ node: Text; start: number; end: number }>;
};

const textBlock = 'p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, div';
const nonBodyText = 'button, script, style, [hidden], [aria-hidden="true"], svg';

function indexText(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: TextIndex['parts'] = [];
  let text = '';
  let previousBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.length || node.parentElement?.closest(nonBodyText)) continue;
    const block = node.parentElement?.closest(textBlock) ?? root;
    // Keep adjacent inline spans searchable as one phrase, with a boundary between blocks.
    if (previousBlock && previousBlock !== block) text += '\n';
    const start = text.length;
    text += node.data;
    parts.push({ node, start, end: text.length });
    previousBlock = block;
  }
  return { text, parts };
}

function findMatches({ text, parts }: TextIndex, query: string): Range[] {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ranges: Range[] = [];
  let part = 0;
  for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
    const start = match.index;
    const end = start + match[0].length;
    while (part < parts.length && parts[part]!.end <= start) part++;
    const first = parts[part];
    while (part < parts.length && parts[part]!.end < end) part++;
    const last = parts[part];
    if (!first || !last || start < first.start || end <= last.start) continue;
    const range = new Range();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    ranges.push(range);
  }
  return ranges;
}

function addHighlight(name: string, ranges: Range[], priority = 0): (() => void) | undefined {
  const registry = CSS.highlights;
  if (!registry || !ranges.length) return;
  const highlight = registry.get(name) ?? new Highlight();
  highlight.priority = priority;
  for (const range of ranges) highlight.add(range);
  registry.set(name, highlight);
  return () => {
    // Other preview panes can have their own searches in the same registry entry.
    for (const range of ranges) highlight.delete(range);
    if (!highlight.size && registry.get(name) === highlight) registry.delete(name);
  };
}

function revealMatch(root: HTMLElement, match: Range): void {
  const target = match.getClientRects()[0];
  if (!target) return;
  const viewport = root.getBoundingClientRect();
  if (target.top < viewport.top || target.bottom > viewport.bottom) {
    root.scrollBy({ top: target.top - viewport.top - (viewport.height - target.height) / 2 });
  }
  const codeBlock = match.startContainer.parentElement?.closest('pre');
  if (!codeBlock || codeBlock.scrollWidth <= codeBlock.clientWidth) return;
  const codeViewport = codeBlock.getBoundingClientRect();
  if (target.left < codeViewport.left || target.right > codeViewport.right) {
    codeBlock.scrollBy({ left: target.left - codeViewport.left - 12 });
  }
}
