import {
  absoluteDirname,
  absoluteEquals,
  containsAbsolute,
  joinAbsolute,
  parsePortableRelativePath,
  portableRelativePathParts,
  type HostFileRef,
} from '@emdash/core/primitives/path/api';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import {
  documentPathSchema,
  documentRevisionSchema,
  type DocumentWorkspace,
  type ManagementDocument,
} from '../api/documents';
import type { Coordinator } from '../api/types';

const MAX_DOCUMENT_BYTES = 512 * 1024;
export type DocumentRuntime = {
  workspaceId: string;
  root: HostFileRef;
  runtime: Pick<HostRuntimesClient, 'files' | 'git'>;
};
export class CoordinatorDocuments {
  constructor(private readonly resolve: (record: Coordinator) => Promise<DocumentRuntime>) {}
  private async storage(record: Coordinator) {
    const config = record.params?.workspaceConfig.git;
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
  async read(
    record: Coordinator,
    input: string,
    requestedRevision?: string
  ): Promise<ManagementDocument> {
    const requested = requestedRevision
      ? documentRevisionSchema.parse(requestedRevision)
      : undefined;
    const storage = await this.storage(record);
    const { relative, path } = this.path(storage.root, input);
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
      content = file.data.content;
      revision = `disk:${file.data.etag}`;
      if (requested && requested !== revision)
        throw new Error(
          'The uncommitted document changed. Read its current version or use a saved commit.'
        );
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
}
