import { describe, expect, it } from 'vitest';
import { createHeadingSlugger, rehypeHeadingIds, type MarkdownHeading } from './heading-ids';

function heading(tagName: string, ...text: string[]) {
  return {
    type: 'element',
    tagName,
    properties: {} as Record<string, unknown>,
    children: text.map((value) => ({ type: 'text', value })),
  };
}

describe('createHeadingSlugger', () => {
  it('keeps Chinese titles and falls back when the title is only punctuation', () => {
    const slug = createHeadingSlugger();
    expect(slug('架构 设计')).toBe('架构-设计');
    expect(slug('***')).toBe('section');
  });

  it('never repeats a slug when a suffixed title collides with a literal one', () => {
    const slug = createHeadingSlugger();
    expect(['Setup', 'Setup 1', 'Setup', 'Setup'].map(slug)).toEqual([
      'setup',
      'setup-1',
      'setup-2',
      'setup-3',
    ]);
  });
});

describe('rehypeHeadingIds', () => {
  it('assigns prefixed ids from heading text and reports non-empty headings', () => {
    const quoted = heading('h2', 'Quoted');
    const empty = heading('h1');
    const tree = {
      type: 'root',
      children: [
        heading('h1', 'Intro'),
        { type: 'element', tagName: 'blockquote', children: [quoted] },
        empty,
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: '# not a heading' }] },
      ],
    };
    let reported: MarkdownHeading[] = [];
    rehypeHeadingIds({ prefix: 'md-a-', onHeadings: (headings) => (reported = headings) })(tree);

    expect(quoted.properties.id).toBe('md-a-quoted');
    expect(empty.properties.id).toBe('md-a-section');
    expect(reported).toEqual([
      { depth: 1, text: 'Intro', id: 'md-a-intro' },
      { depth: 2, text: 'Quoted', id: 'md-a-quoted' },
    ]);
  });
});
