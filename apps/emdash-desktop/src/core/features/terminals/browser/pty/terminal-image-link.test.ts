import { describe, expect, it } from 'vitest';
import { classifyOscLink, isImagePath } from './terminal-image-link';

describe('terminal image links', () => {
  it.each([
    ['file:///private/tmp/organizer-play.png', '/private/tmp/organizer-play.png'],
    ['file:///tmp/%E5%9B%BE%E7%89%87%20%23%201.PNG', '/tmp/图片 # 1.PNG'],
    ['file://localhost/tmp/test.webp', '/tmp/test.webp'],
    ['file:///C:/Users/Test/Some%20File.jpg', '/C:/Users/Test/Some File.jpg'],
    ['file:///tmp/diagram.svg', '/tmp/diagram.svg'],
  ])('resolves %s to a host path', (uri, path) => {
    expect(classifyOscLink(uri)).toEqual({ kind: 'image', path });
  });

  it.each([
    'file://other-host/tmp/image.png',
    'file:///tmp/image.png?other=1',
    'file:///tmp/image.png#fragment',
    'file:///tmp%2fimage.png',
    'file:///tmp/%00image.png',
    'file:///tmp/%ZZimage.png',
    'file:///tmp%5Cimage.png',
    'file:///tmp\\image.png',
    'file:///tmp/image.png\n',
    'file:/tmp/image.png',
  ])('rejects unsafe image URL %s', (uri) => {
    expect(classifyOscLink(uri)).toEqual({ kind: 'invalid-image' });
  });

  it('does not take over other protocols or non-image files', () => {
    expect(classifyOscLink('https://example.com/image.png')).toEqual({ kind: 'web' });
    expect(classifyOscLink('file:///tmp/source.ts')).toBeNull();
    expect(classifyOscLink('javascript:alert(1)')).toBeNull();
    expect(classifyOscLink('ompfile://host/tmp/image.png')).toBeNull();
    expect(isImagePath('test.png')).toBe(true);
    expect(isImagePath('test.ts')).toBe(false);
  });
});
