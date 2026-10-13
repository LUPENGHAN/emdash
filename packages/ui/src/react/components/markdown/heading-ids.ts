export interface MarkdownHeading {
  depth: number;
  text: string;
  id: string;
}

export interface RehypeHeadingIdsOptions {
  prefix: string;
  /** Receives the headings with non-empty text, in document order, after ids are assigned. */
  onHeadings?: (headings: MarkdownHeading[]) => void;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const HEADING_TAG = /^h([1-6])$/;

/**
 * Assigns `id` to every h1–h6 element from its own rendered text. Must run after
 * rehype-sanitize (which would clobber ids) and before rehype-katex (so math
 * contributes its source text rather than KaTeX markup). Repeated titles get
 * `-1`, `-2`, … until the slug is unused. Chinese and other letters stay in the slug.
 */
export function rehypeHeadingIds({ prefix, onHeadings }: RehypeHeadingIdsOptions) {
  return (tree: HastNode) => {
    const slug = createHeadingSlugger();
    const headings: MarkdownHeading[] = [];
    const visit = (node: HastNode) => {
      const match = node.type === 'element' ? HEADING_TAG.exec(node.tagName ?? '') : null;
      if (match) {
        const text = textContent(node).replace(/\s+/g, ' ').trim();
        const id = `${prefix}${slug(text)}`;
        node.properties = { ...node.properties, id };
        if (text) headings.push({ depth: Number(match[1]), text, id });
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    onHeadings?.(headings);
  };
}

function textContent(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textContent).join('');
}

export function createHeadingSlugger(): (text: string) => string {
  const used = new Set<string>();
  return (text) => {
    const base = slugifyHeading(text);
    let slug = base;
    for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    used.add(slug);
    return slug;
  };
}

function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}
