import { encodeResourceUri, type HostFileRef } from '@emdash/core/primitives/path/api';
import { getFilesClient } from './client';

/** The files runtime reads at most this much in one go. */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const ANDROID_CHUNK_BYTES = 512 * 1024;

/**
 * Emdash's Android app saves files through this bridge: its WebView does no downloads of
 * its own. The file goes over in base64 chunks, to keep the app's memory flat.
 */
type AndroidFileBridge = {
  beginFile(name: string, mimeType: string): string;
  appendFile(id: string, base64: string): void;
  /** Where it was saved, as the user would find it (e.g. "Download/notes.md"). */
  endFile(id: string): string;
  abortFile(id: string): void;
};

declare global {
  interface Window {
    EmdashAndroidFiles?: AndroidFileBridge;
  }
}

export type DownloadedFile = { name: string; size: number; savedTo: string | null };

/**
 * Downloads a file from the computer Emdash runs on to this device: the browser's own
 * download, or the Android app's Downloads folder. Throws with a message to show on failure.
 */
export async function downloadFile(ref: HostFileRef): Promise<DownloadedFile> {
  const client = await getFilesClient();
  const result = await client.fs.readBytes({
    uri: encodeResourceUri(ref),
    options: { maxBytes: DOWNLOAD_MAX_BYTES },
  });
  if (!result.success) {
    const error = result.error as { message?: string; type?: string };
    throw new Error(error.message || error.type || 'The file could not be read.');
  }
  const { meta } = result.data;
  if (meta.truncated) throw new Error('Files over 100 MB cannot be downloaded here.');
  const bytes = await result.data.bytes();

  const android = window.EmdashAndroidFiles;
  if (android) {
    const id = android.beginFile(meta.name, meta.mimeType);
    try {
      for (let offset = 0; offset < bytes.length; offset += ANDROID_CHUNK_BYTES) {
        android.appendFile(id, toBase64(bytes.subarray(offset, offset + ANDROID_CHUNK_BYTES)));
      }
      return { name: meta.name, size: bytes.length, savedTo: android.endFile(id) };
    } catch (error) {
      android.abortFile(id);
      throw error;
    }
  }

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: meta.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = meta.name;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken the blob by the time the click returns; leave it a moment anyway.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name: meta.name, size: bytes.length, savedTo: null };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
