import {
  absoluteBasename,
  absoluteDirname,
  encodeResourceUri,
  joinAbsolute,
} from '@emdash/core/primitives/path/api';
import { MAX_FILE_UPLOAD_BYTES } from '@emdash/core/runtimes/files/api';
import { getFilesClient } from '@core/features/files/api/browser/client';
import {
  hostFileRefFromNativePath,
  hostPathFromNative,
  nativePathFromHost,
} from '@core/primitives/desktop-runtime/api';

export type ImportedMarkdownImage = Readonly<{
  markdown: string;
  path: string;
}>;

/** Uploads images beside a Markdown document and returns links ready for insertion. */
export async function importMarkdownImages(args: {
  documentPath: string;
  sshConnectionId?: string;
  files: readonly File[];
}): Promise<ImportedMarkdownImage[]> {
  if (args.files.length === 0) return [];

  const invalid = args.files.find((file) => !isSupportedImageFile(file));
  if (invalid) throw new Error(`${invalid.name} 不是支持的图片文件。`);
  const oversized = args.files.find((file) => file.size > MAX_FILE_UPLOAD_BYTES);
  if (oversized) throw new Error(`${oversized.name} 超过 10 MB 上传限制。`);

  const document = hostPathFromNative(args.documentPath);
  const parent = absoluteDirname(document);
  if (!parent) throw new Error('当前 Markdown 文件没有可用的父目录。');

  const documentName = absoluteBasename(document);
  const stem = documentName.replace(/\.[^.]+$/u, '') || 'markdown';
  const assetDirectoryName = `${sanitizeFileName(stem)}.assets`;
  const assetDirectory = joinOrThrow(parent, assetDirectoryName);
  const assetDirectoryPath = nativePathFromHost(assetDirectory);
  const client = await getFilesClient();
  const uriFor = (path: string) =>
    encodeResourceUri(hostFileRefFromNativePath(path, args.sshConnectionId));

  const directoryUri = uriFor(assetDirectoryPath);
  const directoryExists = await client.fs.exists({ uri: directoryUri });
  if (!directoryExists.success) throw new Error(errorMessage(directoryExists.error));
  if (!directoryExists.data.exists) {
    const created = await client.fs.createDirectory({ uri: directoryUri });
    if (!created.success) throw new Error(errorMessage(created.error));
  }

  const imported: ImportedMarkdownImage[] = [];
  for (const file of args.files) {
    const safeName = sanitizeFileName(file.name) || 'image';
    const destinationName = await availableName({
      initialName: safeName,
      exists: async (name) => {
        const candidate = nativePathFromHost(joinOrThrow(assetDirectory, name));
        const result = await client.fs.exists({ uri: uriFor(candidate) });
        if (!result.success) throw new Error(errorMessage(result.error));
        return result.data.exists;
      },
    });
    const destination = nativePathFromHost(joinOrThrow(assetDirectory, destinationName));
    const uploaded = await client.fs.upload(
      { uri: uriFor(destination), overwrite: false },
      {
        name: destinationName,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        lastModified: file.lastModified,
        source: file.stream(),
      }
    );
    if (!uploaded.success) throw new Error(errorMessage(uploaded.error));

    const label = file.name.replace(/\.[^.]+$/u, '') || '图片';
    imported.push({
      path: destination,
      markdown: `![${escapeMarkdownLabel(label)}](./${assetDirectoryName}/${destinationName})`,
    });
  }
  return imported;
}

export function sanitizeFileName(name: string): string {
  const lastDot = name.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < name.length - 1;
  const base = hasExtension ? name.slice(0, lastDot) : name;
  const extension = hasExtension ? name.slice(lastDot).toLowerCase() : '';
  const safeBase = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*%]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '');
  const safeExtension = extension.replace(/[^.a-z0-9_-]/gu, '');
  return `${safeBase || 'image'}${safeExtension}`;
}

/** Finder and some remote desktops omit MIME types, so extensions are a required fallback. */
export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type.toLowerCase().startsWith('image/')) return true;
  return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu.test(file.name);
}

async function availableName(args: {
  initialName: string;
  exists: (name: string) => Promise<boolean>;
}): Promise<string> {
  if (!(await args.exists(args.initialName))) return args.initialName;
  const dot = args.initialName.lastIndexOf('.');
  const hasExtension = dot > 0;
  const base = hasExtension ? args.initialName.slice(0, dot) : args.initialName;
  const extension = hasExtension ? args.initialName.slice(dot) : '';
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}${extension}`;
    if (!(await args.exists(candidate))) return candidate;
  }
  throw new Error('无法为图片生成不冲突的文件名。');
}

function joinOrThrow(
  base: Parameters<typeof joinAbsolute>[0],
  segment: string
): ReturnType<typeof hostPathFromNative> {
  const joined = joinAbsolute(base, segment);
  if (!joined.success) throw new Error(joined.error.message);
  return joined.data;
}

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '图片导入失败。';
}
