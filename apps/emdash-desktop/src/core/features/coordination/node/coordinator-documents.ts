import {
  absoluteDirname,
  absoluteEquals,
  containsAbsolute,
  joinAbsolute,
  parsePortableRelativePath,
  portableRelativePathParts,
  type HostFileRef,
} from '@emdash/core/primitives/path/api';
import { localBranchRefSchema } from '@emdash/core/runtimes/git/api';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import {
  documentCommitSchema,
  documentWriteSchema,
  type DocumentWrite,
  type DocumentCommit,
  documentPathSchema,
  documentRevisionSchema,
  type DocumentWorkspace,
  type ManagementDocument,
} from '../api/documents';
import type { Coordinator, DocumentStorage } from '../api/types';

const MAX_DOCUMENT_BYTES = 512 * 1024;
export type DocumentRuntime = {
  workspaceId: string;
  root: HostFileRef;
  runtime: Pick<HostRuntimesClient, 'files' | 'git'>;
};
export class CoordinatorDocuments {
  constructor(
    private readonly resolve: (
      record: Coordinator,
      options?: { migrationSource?: boolean }
    ) => Promise<DocumentRuntime>
  ) {}
  async readMigrationSource(record: Coordinator, source: DocumentStorage, path: string) {
    const storage = await this.resolve(
      { ...record, documentStorage: source },
      { migrationSource: true }
    );
    return this.readDisk(record, path, storage);
  }
  async copyMigrationDocument(
    record: Coordinator,
    target: DocumentStorage,
    document: ManagementDocument
  ) {
    const bound = { ...record, documentStorage: target };
    const storage = await this.storage(bound);
    const parts = documentPathSchema.parse(document.path).split('/');
    const canonicalRoot = await storage.runtime.files.fs.realPath({ path: storage.root.path });
    if (!canonicalRoot.success) throw new Error('The migration destination is unavailable.');
    for (let count = 1; count < parts.length; count++) {
      const relative = parts.slice(0, count).join('/');
      const { path } = this.path(storage.root, relative);
      const exists = await storage.runtime.files.fs.exists({ path });
      if (!exists.success) throw new Error('The migration folder is unavailable.');
      if (!exists.data.exists) {
        const created = await storage.runtime.files.fs.createDirectory({ path });
        if (!created.success)
          throw new Error(`Could not create migration folder: ${created.error.type}`);
      }
      const real = await storage.runtime.files.fs.realPath({ path });
      const expected = this.path({ ...storage.root, path: canonicalRoot.data.path }, relative).path;
      if (!real.success || !absoluteEquals(real.data.path, expected))
        throw new Error('Migration folders must not contain symbolic links.');
    }
    const { path } = this.path(storage.root, document.path);
    const exists = await storage.runtime.files.fs.exists({ path });
    if (!exists.success) throw new Error('The migration file is unavailable.');
    if (exists.data.exists) {
      const copied = await this.read(bound, document.path);
      if (copied.content !== document.content)
        throw new Error(
          `The migration destination changed: ${document.path}. Original storage is preserved.`
        );
      return copied;
    }
    return this.write(bound, { path: document.path, content: document.content });
  }
  private async storage(record: Coordinator) {
    const config = (record.documentStorage?.params ?? record.params)?.workspaceConfig.git;
    if (record.documentStorage && record.documentStorage.state !== 'ready')
      throw new Error('Document storage setup is incomplete. Retry its saved project.');
    if (config?.kind === 'none')
      throw new Error(
        'Management document Git history is not applicable to this directory project.'
      );
    if (config?.kind !== 'management')
      throw new Error(
        'This main agent needs document migration before using management documents. Its original workspace is preserved.'
      );
    const storage = await this.resolve(record);
    const head = (
      await storage.runtime.git.checkout.model
        .state({ checkout: storage.root.path }, 'head')
        .snapshot()
    ).data;
    if (head.kind !== 'branch' || head.ref !== `refs/heads/${config.branchName}`)
      throw new Error(`Return the document workspace to ${config.branchName} before using it.`);
    return { ...storage, branch: config.branchName, revision: head.oid };
  }
  async describe(record: Coordinator): Promise<DocumentWorkspace> {
    const { workspaceId, root, branch, revision } = await this.storage(record);
    return { workspaceId, root, branch, revision };
  }
  private path(root: HostFileRef, input: string) {
    const path = documentPathSchema.parse(input);
    const relative = parsePortableRelativePath(path);
    if (!relative.success) throw new Error(relative.error.message);
    const absolute = joinAbsolute(root.path, ...portableRelativePathParts(relative.data));
    if (!absolute.success) throw new Error(absolute.error.message);
    return { relative: relative.data, path: absolute.data };
  }
  private async checkedPath(storage: DocumentRuntime, path: HostFileRef['path'], parent = false) {
    const canonicalRoot = await storage.runtime.files.fs.realPath({ path: storage.root.path });
    const target = parent ? absoluteDirname(path) : path;
    if (!target) throw new Error('A document must have a parent directory.');
    const canonicalPath = await storage.runtime.files.fs.realPath({ path: target });
    if (!canonicalRoot.success || !canonicalPath.success)
      throw new Error(
        'The document or its parent folder is unavailable. Create parent folders in the file tree first.'
      );
    if (!containsAbsolute(canonicalRoot.data.path, canonicalPath.data.path))
      throw new Error('Document links must stay inside the management workspace.');
    return canonicalPath.data.path;
  }
  async create(record: Coordinator, input: string): Promise<DocumentWorkspace> {
    const storage = await this.storage(record);
    const { path } = this.path(storage.root, input);
    await this.checkedPath(storage, path, true);
    const created = await storage.runtime.files.fs.createFile({ path });
    if (!created.success) throw new Error(`Could not create document: ${created.error.type}`);
    return {
      workspaceId: storage.workspaceId,
      root: storage.root,
      branch: storage.branch,
      revision: storage.revision,
    };
  }
  async pushTarget(record: Coordinator, remote: string) {
    const storage = await this.storage(record);
    const result = await storage.runtime.git.checkout.inspectPushTarget({
      checkout: storage.root.path,
      remote,
    });
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  }
  async write(record: Coordinator, input: DocumentWrite): Promise<ManagementDocument> {
    const selected = documentWriteSchema.parse(input);
    if (
      Buffer.byteLength(selected.content, 'utf8') > MAX_DOCUMENT_BYTES ||
      selected.content.includes('\0')
    )
      throw new Error('Choose a text document no larger than 512 KiB.');
    const storage = await this.storage(record);
    const { path } = this.path(storage.root, selected.path);
    const exists = await storage.runtime.files.fs.exists({ path });
    if (!exists.success) throw new Error('The document destination is unavailable.');
    if (exists.data.exists && !selected.expectedRevision)
      throw new Error('Read the document and provide its disk version before replacing it.');
    if (!exists.data.exists) {
      if (selected.expectedRevision) throw new Error('The document no longer exists.');
      const realParent = await this.checkedPath(storage, path, true);
      const root = await storage.runtime.files.fs.realPath({ path: storage.root.path });
      if (!root.success) throw new Error('The document storage root is unavailable.');
      const expectedParent = absoluteDirname(
        this.path({ ...storage.root, path: root.data.path }, selected.path).path
      );
      if (!expectedParent || !absoluteEquals(expectedParent, realParent))
        throw new Error('Write document files directly instead of through symbolic links.');
      const created = await storage.runtime.files.fs.createFile({ path });
      if (!created.success) throw new Error(`Could not create document: ${created.error.type}`);
    }
    const before = await this.read(record, selected.path, selected.expectedRevision);
    const written = await storage.runtime.files.fs.writeFile({
      path,
      content: selected.content,
      encoding: 'utf8',
      precondition: { kind: 'etag', etag: before.revision.slice('disk:'.length) },
    });
    if (!written.success) throw new Error(`Could not save document: ${written.error.type}`);
    return this.read(record, selected.path);
  }
  async pushTargets(record: Coordinator) {
    const storage = await this.storage(record);
    const remotes = (
      await storage.runtime.git.repository.model
        .state({ repository: storage.root.path }, 'remotes')
        .snapshot()
    ).data.remotes;
    const targets = [];
    const unavailable = [];
    for (const { name } of remotes) {
      try {
        targets.push(await this.pushTarget(record, name));
      } catch (error) {
        unavailable.push({ remote: name, message: String(error) });
      }
    }
    return { targets, unavailable };
  }
  async preparePush(record: Coordinator, expectedRevision: string) {
    const storage = await this.storage(record);
    const saved = record.documentPushTarget;
    if (!saved)
      throw new Error('Configure a personal fork for management documents before pushing.');
    if (storage.revision.toLowerCase() !== expectedRevision.toLowerCase())
      throw new Error('The management branch changed. Refresh documents before pushing.');
    const target = await this.pushTarget(record, saved.remote);
    if (target.fingerprint !== saved.fingerprint)
      throw new Error(
        'The configured document destination changed. Choose and save the remote again before pushing.'
      );
    const ref = localBranchRefSchema.parse(`refs/heads/${storage.branch}`);
    return {
      workspaceId: storage.workspaceId,
      remote: saved.remote,
      expectedRemoteFingerprint: saved.fingerprint,
      sourceRef: ref,
      targetRef: ref,
      oid: storage.revision,
    };
  }
  async commit(record: Coordinator, input: DocumentCommit): Promise<{ hash: string }> {
    const selected = documentCommitSchema.parse(input);
    const storage = await this.storage(record);
    if (storage.revision.toLowerCase() !== selected.expectedRevision.toLowerCase())
      throw new Error('The management branch changed. Refresh documents before committing.');
    const paths = [];
    for (const path of new Set(selected.paths)) {
      const target = this.path(storage.root, path);
      const stat = await storage.runtime.files.fs.stat({ path: target.path });
      if (!stat.success && stat.error.type === 'not-found') {
        await this.checkedPath(storage, target.path, true);
        await this.read(record, path, storage.revision);
      } else {
        if (!stat.success) throw new Error(`Could not inspect document: ${stat.error.type}`);
        await this.read(record, path);
      }
      paths.push(target.relative);
    }
    const committed = await storage.runtime.git.checkout.model.mutate('commitFiles', {
      key: { checkout: storage.root.path },
      input: {
        paths,
        message: selected.message,
        expectedHead: selected.expectedRevision,
        expectedBranch: localBranchRefSchema.parse(`refs/heads/${storage.branch}`),
      },
    });
    if (!committed.success)
      throw new Error(`Could not commit documents: ${committed.error.message}`);
    return committed.data.data;
  }
  async read(
    record: Coordinator,
    input: string,
    requestedRevision?: string
  ): Promise<ManagementDocument> {
    const requested = requestedRevision
      ? documentRevisionSchema.parse(requestedRevision)
      : undefined;
    const storage = await this.storage(record);
    const { relative } = this.path(storage.root, input);
    let content: string;
    let revision: string;
    if (requested && !requested.startsWith('disk:')) {
      const base = await storage.runtime.git.checkout.getMergeBase({
        checkout: storage.root.path,
        baseOid: requested,
        headOid: storage.revision,
      });
      if (!base.success || base.data.oid.toLowerCase() !== requested.toLowerCase())
        throw new Error(
          'The requested document version is outside this management branch history.'
        );
      const snapshot = await storage.runtime.git.checkout.getFile({
        checkout: storage.root.path,
        path: relative,
        source: { kind: 'revision', revision: { kind: 'commit', sha: requested } },
      });
      if (!snapshot.success || snapshot.data.content === null)
        throw new Error('This document is unavailable at the requested version.');
      content = snapshot.data.content;
      revision = requested;
    } else {
      return this.readDisk(record, input, storage, requested);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES || content.includes('\0'))
      throw new Error('Choose a text document no larger than 512 KiB.');
    return {
      coordinatorId: record.id,
      workspaceId: storage.workspaceId,
      path: input,
      revision,
      content,
    };
  }
  private async readDisk(
    record: Coordinator,
    input: string,
    storage: DocumentRuntime,
    requested?: string
  ): Promise<ManagementDocument> {
    const { path } = this.path(storage.root, input);
    const real = await this.checkedPath(storage, path);
    const root = await storage.runtime.files.fs.realPath({ path: storage.root.path });
    if (!root.success) throw new Error('The document workspace is unavailable.');
    const expected = this.path({ ...storage.root, path: root.data.path }, input).path;
    if (!absoluteEquals(expected, real))
      throw new Error('Read document files directly instead of through symbolic links.');
    const file = await storage.runtime.files.fs.readText({
      path,
      options: { maxBytes: MAX_DOCUMENT_BYTES },
    });
    if (!file.success || file.data.truncated)
      throw new Error('The document is unavailable or exceeds the 512 KiB text limit.');
    const content = file.data.content;
    const revision = `disk:${file.data.etag}`;
    if (requested && requested !== revision)
      throw new Error(
        'The uncommitted document changed. Read its current version or use a saved commit.'
      );
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES || content.includes('\0'))
      throw new Error('Choose a text document no larger than 512 KiB.');
    return {
      coordinatorId: record.id,
      workspaceId: storage.workspaceId,
      path: input,
      revision,
      content,
    };
  }
}
