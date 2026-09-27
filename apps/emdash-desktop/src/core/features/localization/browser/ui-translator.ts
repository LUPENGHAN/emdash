/**
 * Translates the interface in place: text nodes and a few attributes whose (trimmed,
 * whitespace-collapsed) English text is in the dictionary are swapped for the
 * translation, and swapped back when the translator stops. Components stay untouched,
 * so upstream changes merge cleanly; text the dictionary lacks stays English.
 *
 * Content is never translated: terminals, editors, code, form fields and anything under
 * `translate="no"` (conversation transcripts) are skipped; `translate="yes"` opts a
 * subtree back in.
 */
export type UiDictionary = {
  /** Exact English text → translation. */
  strings: Record<string, string>;
  /** English with `{0}`, `{1}`… placeholders → translation using the same placeholders. */
  patterns: Record<string, string>;
};

export type UiTranslator = {
  start(): void;
  stop(): void;
  /** English text seen on screen that the dictionary lacks (for filling it in). */
  missing(): string[];
};

const SKIP_SELECTOR = [
  '.xterm',
  '.monaco-editor',
  '.monaco-diff-editor',
  '.cm-editor',
  'pre',
  'code',
  'kbd',
  'textarea',
  'script',
  'style',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(',');
const ATTRIBUTES = ['placeholder', 'title', 'aria-label'] as const;
const MAX_MISSING = 2000;

type Pattern = { regex: RegExp; translation: string };

function compilePatterns(patterns: Record<string, string>): Pattern[] {
  return (
    Object.entries(patterns)
      // Longer (more specific) patterns first: "Delete {0} files" before "Delete {0}".
      .sort(([a], [b]) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
      .map(([english, translation]) => ({
        regex: new RegExp(
          `^${english
            .split(/(\{\d+\})/)
            .map((part) =>
              /^\{\d+\}$/.test(part) ? '(.+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            )
            .join('')}$`,
          's'
        ),
        translation,
      }))
  );
}

export function createUiTranslator(
  dictionary: UiDictionary,
  root: () => HTMLElement = () => document.body
): UiTranslator {
  const strings = new Map(Object.entries(dictionary.strings));
  const patterns = compilePatterns(dictionary.patterns);
  const resolved = new Map<string, string | null>();
  const missing = new Set<string>();
  /** Nodes we changed, with what they said before and what we wrote. */
  const texts = new WeakMap<Text, { source: string; written: string }>();
  const attributes = new WeakMap<Element, Map<string, { source: string; written: string }>>();
  let observer: MutationObserver | null = null;

  const lookup = (normalized: string): string | null => {
    const cached = resolved.get(normalized);
    if (cached !== undefined) return cached;
    let result = strings.get(normalized) ?? null;
    if (result === null) {
      for (const pattern of patterns) {
        const match = pattern.regex.exec(normalized);
        if (match) {
          result = pattern.translation.replace(
            /\{(\d+)\}/g,
            (_, index: string) => match[Number(index) + 1] ?? ''
          );
          break;
        }
      }
    }
    if (result === null && missing.size < MAX_MISSING) missing.add(normalized);
    resolved.set(normalized, result);
    return result;
  };

  const translate = (text: string): string | null => {
    if (!/[A-Za-z]/.test(text)) return null;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const translation = lookup(normalized);
    if (translation === null) return null;
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    const trail = /\s*$/.exec(text)?.[0] ?? '';
    return `${lead}${translation}${trail}`;
  };

  const skipped = (element: Element | null): boolean => {
    if (!element) return true;
    const marked = element.closest('[translate]');
    if (marked?.getAttribute('translate') === 'no') return true;
    const content = element.closest(SKIP_SELECTOR);
    // A `translate="yes"` inside skipped content does not re-enable it.
    return content !== null;
  };

  /** What a node said before we touched it (its current text if we did not, or it changed since). */
  const sourceOf = (node: Text): string => {
    const record = texts.get(node);
    return record && node.data === record.written ? record.source : node.data;
  };

  const write = (node: Text, source: string, written: string) => {
    if (written === source) texts.delete(node);
    else texts.set(node, { source, written });
    if (node.data !== written) node.data = written;
  };

  /**
   * React renders `{count} files selected` as several sibling text nodes. When a parent
   * holds only text, its whole sentence is looked up first (so patterns match it), the
   * translation goes in the first node and the rest are emptied; otherwise each node is
   * translated on its own.
   */
  const handleTextGroup = (nodes: Text[]) => {
    const sources = nodes.map(sourceOf);
    const whole = translate(sources.join(''));
    nodes.forEach((node, index) => {
      if (whole !== null) {
        write(node, sources[index]!, index === 0 ? whole : '');
      } else {
        write(node, sources[index]!, translate(sources[index]!) ?? sources[index]!);
      }
    });
  };

  const handleText = (node: Text) => {
    const record = texts.get(node);
    if (record && node.data === record.written) return; // Our own write.
    const parent = node.parentElement;
    if (skipped(parent)) {
      if (record) texts.delete(node);
      return;
    }
    const siblings = parent!.childNodes;
    if (siblings.length > 1 && [...siblings].every((child) => child.nodeType === Node.TEXT_NODE)) {
      handleTextGroup([...siblings] as Text[]);
      return;
    }
    const source = sourceOf(node);
    write(node, source, translate(source) ?? source);
  };

  const handleAttribute = (element: Element, name: string) => {
    const value = element.getAttribute(name);
    const records = attributes.get(element);
    const record = records?.get(name);
    if (value === null) {
      records?.delete(name);
      return;
    }
    if (record && value === record.written) return;
    // A text area's own text is content, its placeholder is not.
    if (skipped(element.tagName === 'TEXTAREA' ? element.parentElement : element)) return;
    const translation = translate(value);
    if (translation !== null && translation !== value) {
      const map = records ?? new Map<string, { source: string; written: string }>();
      map.set(name, { source: value, written: translation });
      attributes.set(element, map);
      element.setAttribute(name, translation);
    } else {
      records?.delete(name);
    }
  };

  const handleElement = (element: Element) => {
    if (skipped(element)) {
      // A skipped root can still contain opted-in (`translate="yes"`) parts.
      for (const optedIn of element.querySelectorAll('[translate="yes"]')) {
        if (!skipped(optedIn)) handleSubtree(optedIn);
      }
      return;
    }
    handleSubtree(element);
  };

  const handleSubtree = (element: Element) => {
    for (const name of ATTRIBUTES) if (element.hasAttribute(name)) handleAttribute(element, name);
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          const child = node as Element;
          if (child.matches(SKIP_SELECTOR) || child.getAttribute('translate') === 'no') {
            if (child.tagName === 'TEXTAREA' && child.hasAttribute('placeholder')) {
              handleAttribute(child, 'placeholder');
            }
            for (const optedIn of child.querySelectorAll('[translate="yes"]')) {
              if (!skipped(optedIn)) handleSubtree(optedIn);
            }
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) handleText(node as Text);
      else
        for (const name of ATTRIBUTES) {
          if ((node as Element).hasAttribute(name)) handleAttribute(node as Element, name);
        }
    }
  };

  const onMutations = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        handleText(mutation.target as Text);
      } else if (mutation.type === 'attributes' && mutation.attributeName) {
        handleAttribute(mutation.target as Element, mutation.attributeName);
      } else {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) handleText(node as Text);
          else if (node.nodeType === Node.ELEMENT_NODE) handleElement(node as Element);
        }
      }
    }
  };

  return {
    start() {
      if (observer) return;
      const target = root();
      handleElement(target);
      observer = new MutationObserver(onMutations);
      observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...ATTRIBUTES],
      });
    },
    stop() {
      observer?.disconnect();
      observer = null;
      // Put back what we changed in the live page; detached nodes are gone anyway.
      const walker = document.createTreeWalker(
        root(),
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
      );
      for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          const record = texts.get(node as Text);
          if (record && (node as Text).data === record.written) (node as Text).data = record.source;
          texts.delete(node as Text);
        } else {
          const records = attributes.get(node as Element);
          for (const [name, record] of records ?? []) {
            if ((node as Element).getAttribute(name) === record.written) {
              (node as Element).setAttribute(name, record.source);
            }
          }
          attributes.delete(node as Element);
        }
      }
      resolved.clear();
    },
    missing: () => [...missing].sort((a, b) => a.localeCompare(b)),
  };
}
