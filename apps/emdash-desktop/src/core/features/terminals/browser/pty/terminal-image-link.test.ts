import { describe, expect, it } from 'vitest';
import { classifyOscLink, isImagePath } from './terminal-image-link';

const shortLink = 'https://open-file.emdash.invalid/open';

describe('terminal OSC links', () => {
  it.each([
    ['file:///private/tmp/organizer-play.png', '/private/tmp/organizer-play.png'],
    ['file:///tmp/%E5%9B%BE%E7%89%87%20%23%201.PNG', '/tmp/图片 # 1.PNG'],
    ['file://localhost/tmp/test.webp', '/tmp/test.webp'],
    ['file:///C:/Users/Test/Some%20File.jpg', '/C:/Users/Test/Some File.jpg'],
    ['file:///tmp/diagram.svg', '/tmp/diagram.svg'],
  ])('resolves %s to a host path', (uri, path) => {
    expect(classifyOscLink(uri)).toEqual({ kind: 'file', path });
  });

  it.each([
    ['file:///tmp/source.ts', '/tmp/source.ts'],
    ['file:///tmp/proposal.md', '/tmp/proposal.md'],
    ['file:///tmp/no-extension', '/tmp/no-extension'],
  ])('resolves non-image file URL %s to a host path', (uri, path) => {
    expect(classifyOscLink(uri)).toEqual({ kind: 'file', path });
  });

  it.each([
    ['/tmp/source.ts', '/tmp/source.ts'],
    ['/tmp/proposal.md:42', '/tmp/proposal.md'],
    ['/tmp/proposal.md#L42C3', '/tmp/proposal.md'],
    ['./src/app.ts:7:2', './src/app.ts'],
    ['src/core/app.ts#L7', 'src/core/app.ts'],
    ['C:\\repo\\src\\app.ts:7', 'C:\\repo\\src\\app.ts'],
  ])('resolves path target %s to a host path', (target, path) => {
    expect(classifyOscLink(target)).toEqual({ kind: 'file', path });
  });

  it('resolves a short Emdash HTTPS link to its local file', () => {
    const target = `${shortLink}?path=${encodeURIComponent('/Users/test/project/src/app.ts:42')}`;
    expect(classifyOscLink(target)).toEqual({
      kind: 'file',
      path: '/Users/test/project/src/app.ts',
    });
  });

  it.each([
    shortLink,
    `${shortLink}?path=relative-file.ts`,
    `${shortLink}?path=%2Ftmp%2Fapp.ts&path=%2Ftmp%2Fother.ts`,
    `${shortLink}?path=%2Ftmp%2Fapp.ts&other=1`,
    `${shortLink}?path=%2Ftmp%2Fapp.ts#fragment`,
  ])('blocks malformed Emdash file link %s', (uri) => {
    expect(classifyOscLink(uri)).toEqual({ kind: 'invalid-file' });
  });

  it('does not trust lookalike Emdash file-link hosts', () => {
    expect(
      classifyOscLink('https://open-file.emdash.invalid.example/open?path=%2Ftmp%2Fapp.ts')
    ).toEqual({ kind: 'web' });
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
  ])('rejects unsafe file URL %s', (uri) => {
    expect(classifyOscLink(uri)).toEqual({ kind: 'invalid-file' });
  });

  it('does not take over other protocols', () => {
    expect(classifyOscLink('https://example.com/image.png')).toEqual({ kind: 'web' });
    expect(classifyOscLink('javascript:alert(1)')).toBeNull();
    expect(classifyOscLink('ompfile://host/tmp/image.png')).toBeNull();
    expect(classifyOscLink('//other-host/tmp/source.ts')).toBeNull();
    expect(classifyOscLink('plain text')).toBeNull();
    expect(isImagePath('test.png')).toBe(true);
    expect(isImagePath('test.ts')).toBe(false);
  });
});
