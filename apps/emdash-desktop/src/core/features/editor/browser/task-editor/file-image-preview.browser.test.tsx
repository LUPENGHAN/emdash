import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import type * as FileContent from '@core/features/files/api/browser/file-content';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import { FILE_CONTENT_TYPES } from './file-content-types';

const { readImageFile } = vi.hoisted(() => ({ readImageFile: vi.fn() }));
vi.mock('@core/features/files/api/browser/file-content', async (importOriginal) => ({
  ...(await importOriginal<typeof FileContent>()),
  readImageFile,
}));

describe('image file preview', () => {
  let host: HTMLDivElement;
  let root: Root;
  let resource: FileTabResource;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    resource = new FileTabResource(
      { path: '/tmp/screenshot.png' },
      { ref: hostFileRefFromNativePath('/tmp/screenshot.png', 'ssh-1') }
    );
    readImageFile.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resource.dispose();
    host.remove();
    vi.unstubAllGlobals();
  });

  it('renders the image read through the remote host reference', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    readImageFile.mockResolvedValue({ success: true, data: { dataUrl, truncated: false } });
    const Preview = FILE_CONTENT_TYPES.image.Preview!;
    await act(async () => root.render(<Preview tab={resource} />));
    await expect.poll(() => host.querySelector('img')?.getAttribute('src')).toBe(dataUrl);
    expect(readImageFile).toHaveBeenCalledExactlyOnceWith(resource.ref);
  });

  it('shows a load error without opening an external application', async () => {
    readImageFile.mockResolvedValue({ success: false });
    const Preview = FILE_CONTENT_TYPES.image.Preview!;
    await act(async () => root.render(<Preview tab={resource} />));
    await expect.poll(() => host.textContent).toContain('Could not load image');
  });
});
