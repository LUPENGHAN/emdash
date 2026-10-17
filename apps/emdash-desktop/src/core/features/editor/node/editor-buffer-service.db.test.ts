import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostRef, LOCAL_HOST_REF, type HostRef } from '@emdash/core/primitives/host/api';
import {
  encodeResourceUri,
  hostFileRef,
  parseAbsolute,
  parseNativeAbsolute,
  type ResourceUri,
} from '@emdash/core/primitives/path/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEditorBufferService,
  editorBufferDatabasePath,
  editorBufferSqliteStore,
  type EditorBufferService,
} from './editor-buffer-service';

const REMOTE_HOST = hostRef('remote', 'ssh-1');

function uriFor(path: string, host: HostRef = LOCAL_HOST_REF): ResourceUri {
  const parsed = parseAbsolute(path, {
    profile: { style: 'posix', unicodeNormalization: 'preserve' },
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return encodeResourceUri(hostFileRef(host, parsed.data));
}

function uriForNative(nativePath: string): ResourceUri {
  const parsed = parseNativeAbsolute(nativePath);
  if (!parsed.success) throw new Error(parsed.error.message);
  return encodeResourceUri(hostFileRef(LOCAL_HOST_REF, parsed.data));
}
describe('editorBufferDatabasePath', () => {
  it('keeps the buffer store beside and scoped to the app database', () => {
    expect(editorBufferDatabasePath('/tmp/emdash-scratch.db')).toBe(
      '/tmp/emdash-scratch-editor-buffers.db'
    );
    expect(editorBufferDatabasePath('/tmp/scratch')).toBe('/tmp/scratch-editor-buffers.db');
  });
});

describe('EditorBufferService', () => {
  let directory: string;
  let databasePath: string;
  let service: EditorBufferService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'emdash-editor-buffers-'));
    databasePath = join(directory, 'editor-buffers.db');
    service = createEditorBufferService({ databasePath });
  });

  afterEach(async () => {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('saves, upserts, and clears buffers keyed by ResourceUri', async () => {
    const uri = uriFor('/repo/src/index.ts');

    await service.saveBuffer(uri, 'first', null);
    await service.saveBuffer(uri, 'second', null);

    await expect(service.listBuffers()).resolves.toEqual([
      { uri, content: 'second', baseHash: null, updatedAt: expect.any(Number) },
    ]);

    await service.clearBuffer(uri);
    await expect(service.listBuffers()).resolves.toEqual([]);
  });

  it('round-trips the base hash of the disk text a buffer was edited from', async () => {
    const uri = uriFor('/repo/src/index.ts');

    await service.saveBuffer(uri, 'draft', 'abc123');

    await expect(service.listBuffers()).resolves.toEqual([
      { uri, content: 'draft', baseHash: 'abc123', updatedAt: expect.any(Number) },
    ]);

    await service.saveBuffer(uri, 'draft 2', null);

    await expect(service.listBuffers()).resolves.toEqual([
      { uri, content: 'draft 2', baseHash: null, updatedAt: expect.any(Number) },
    ]);
  });

  it('lists buffers under a root ResourceUri prefix only', async () => {
    const inside = uriFor('/repo/src/index.ts');
    const nested = uriFor('/repo/docs/notes/readme.md');
    const sibling = uriFor('/repo-other/src/index.ts');
    const outside = uriFor('/elsewhere/file.txt');
    await service.saveBuffer(inside, 'a', null);
    await service.saveBuffer(nested, 'b', null);
    await service.saveBuffer(sibling, 'c', null);
    await service.saveBuffer(outside, 'd', null);

    const buffers = await service.listBuffers(uriFor('/repo'));

    expect(buffers.map((buffer) => buffer.uri).sort()).toEqual([nested, inside].sort());
  });

  it('clears every buffer under a root, keeping siblings and remote rows', async () => {
    const inside = uriFor('/repo/src/index.ts');
    const nested = uriFor('/repo/docs/a.md');
    const sibling = uriFor('/repoX/file.ts');
    const remote = uriFor('/repo/file.ts', REMOTE_HOST);
    await service.saveBuffer(inside, 'a', null);
    await service.saveBuffer(nested, 'b', null);
    await service.saveBuffer(sibling, 'c', null);
    await service.saveBuffer(remote, 'r', null);

    await service.clearBuffers(uriFor('/repo'));

    const buffers = await service.listBuffers();
    expect(buffers.map((buffer) => buffer.uri).sort()).toEqual([sibling, remote].sort());
  });

  it('drops local rows under a removed directory, keeping siblings and remote rows', async () => {
    const inside = uriFor('/worktrees/task-1/src/index.ts');
    const exact = uriFor('/worktrees/task-1');
    const sibling = uriFor('/worktrees/task-11/file.ts');
    const outside = uriFor('/elsewhere/file.ts');
    const remote = uriFor('/worktrees/task-1/file.ts', REMOTE_HOST);
    await service.saveBuffer(inside, 'a', null);
    await service.saveBuffer(exact, 'b', null);
    await service.saveBuffer(sibling, 'c', null);
    await service.saveBuffer(outside, 'd', null);
    await service.saveBuffer(remote, 'r', null);

    await service.clearBuffersUnderLocalPath('/worktrees/task-1');

    const buffers = await service.listBuffers();
    expect(buffers.map((buffer) => buffer.uri).sort()).toEqual([sibling, outside, remote].sort());
  });

  it('scopes root queries to the root host', async () => {
    const local = uriFor('/repo/file.ts');
    const remote = uriFor('/repo/file.ts', REMOTE_HOST);
    await service.saveBuffer(local, 'local', null);
    await service.saveBuffer(remote, 'remote', null);

    await expect(service.listBuffers(uriFor('/repo'))).resolves.toEqual([
      { uri: local, content: 'local', baseHash: null, updatedAt: expect.any(Number) },
    ]);
    await expect(service.listBuffers(uriFor('/repo', REMOTE_HOST))).resolves.toEqual([
      { uri: remote, content: 'remote', baseHash: null, updatedAt: expect.any(Number) },
    ]);
  });

  it('enumerates buffers outside any root via the unscoped listing', async () => {
    const external = uriFor('/tmp/scratch.md');
    const remote = uriFor('/home/user/notes.md', REMOTE_HOST);
    await service.saveBuffer(external, 'scratch', null);
    await service.saveBuffer(remote, 'notes', null);

    const buffers = await service.listBuffers();

    expect(buffers.map((buffer) => buffer.uri).sort()).toEqual([external, remote].sort());
  });

  it('treats percent-encoded characters literally in prefix matching', async () => {
    const spaced = uriFor('/repo dir/my file.ts');
    const decoy = uriFor('/repoXdirY/my file.ts');
    await service.saveBuffer(spaced, 'spaced', null);
    await service.saveBuffer(decoy, 'decoy', null);

    await expect(service.listBuffers(uriFor('/repo dir'))).resolves.toEqual([
      { uri: spaced, content: 'spaced', baseHash: null, updatedAt: expect.any(Number) },
    ]);
  });

  it('prunes stale buffers and local rows whose file no longer exists', async () => {
    const freshPath = join(directory, 'fresh.ts');
    const stalePath = join(directory, 'stale.ts');
    const keptRemote = uriFor('/repo/stale.ts', REMOTE_HOST);
    await writeFile(freshPath, 'fresh\n', 'utf8');
    await writeFile(stalePath, 'stale\n', 'utf8');
    const fresh = uriForNative(freshPath);
    const stale = uriForNative(stalePath);
    await service.saveBuffer(fresh, 'fresh', null);
    await service.saveBuffer(stale, 'stale', null);
    // Local row for a path with no file on disk, plus a remote row that must
    // never be stat-pruned.
    await service.saveBuffer(uriFor('/repo/gone.ts'), 'gone', null);
    await service.saveBuffer(keptRemote, 'remote', null);
    service.dispose();

    const tamper = editorBufferSqliteStore.open(databasePath);
    tamper.connection.run(`UPDATE editor_buffers SET updated_at = 0 WHERE uri = ?`, [
      stale as string,
    ]);
    tamper.close();
    service = createEditorBufferService({ databasePath });

    await service.pruneStale();

    const buffers = await service.listBuffers();
    expect(buffers.map((buffer) => buffer.content).sort()).toEqual(['fresh', 'remote'].sort());
  });

  it('drops and recreates the store on a user_version mismatch', async () => {
    await service.saveBuffer(uriFor('/repo/file.ts'), 'dirty', null);
    service.dispose();

    const tamper = editorBufferSqliteStore.open(databasePath);
    tamper.connection.exec('PRAGMA user_version = 1');
    tamper.close();
    service = createEditorBufferService({ databasePath });

    await expect(service.listBuffers()).resolves.toEqual([]);
    const uri = uriFor('/repo/file.ts');
    await service.saveBuffer(uri, 'fresh start', null);
    await expect(service.listBuffers()).resolves.toEqual([
      { uri, content: 'fresh start', baseHash: null, updatedAt: expect.any(Number) },
    ]);
  });
});
