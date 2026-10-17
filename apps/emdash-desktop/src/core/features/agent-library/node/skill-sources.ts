import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export type SkillSourceRecord = {
  name: string;
  repo: string;
  /** Path inside the repo. Empty means the repository root. */
  path: string;
  ref: string;
  installedTree: string | null;
  remoteTree: string | null;
  /** sha256 of the folder the last time we wrote it. */
  installedHash: string | null;
};

export type SkillSourceView = SkillSourceRecord & {
  dirty: boolean;
  updateAvailable: boolean;
};

type RemoteSnapshot = {
  commit: string;
  rootTree: string;
  entries: { path: string; type: string; sha: string | null; mode: string | null }[];
};

const SOURCES_FILE = path.join('.emdash', 'sources.json');
const UPDATE_DIR = path.join('.emdash', 'skill-update');

/** A skill name is one folder directly inside the library; dot-names are Emdash's own. */
export function isSafeSkillName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name);
}

export function skillFolder(libraryDir: string, name: string): string {
  const root = path.resolve(libraryDir);
  const folder = path.resolve(root, name);
  if (!isSafeSkillName(name) || path.dirname(folder) !== root) {
    throw new Error(`"${name}" is not a valid skill name`);
  }
  return folder;
}

/** Where a remote file lands under `root`; throws for paths that would escape it. */
export function remoteFileTarget(root: string, file: string): string {
  const segments = file.split('/');
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (
    file.includes('\\') ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !target.startsWith(`${base}${path.sep}`)
  ) {
    throw new Error(`Refusing to write ${file} outside the skill folder`);
  }
  return target;
}

/**
 * Reads owner/repo, ref and path from a GitHub link. A ref containing `/` cannot be told
 * apart from the path here; `setSkillSource` resolves that against GitHub.
 */
export function parseGitHubSkillUrl(
  url: string
): Pick<SkillSourceRecord, 'repo' | 'path' | 'ref'> | null {
  const match =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.*))?)?\/?$/.exec(
      url.trim()
    );
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return {
    repo: `${owner}/${repo}`,
    ref: match[3] || 'HEAD',
    path: (match[4] ?? '').replace(/\/$/, ''),
  };
}

export async function listSkillSources(libraryDir: string): Promise<SkillSourceView[]> {
  const views = await mutateSources(libraryDir, async (records) => {
    await importKnownSources(libraryDir, records);
    const out: SkillSourceView[] = [];
    for (const record of Object.values(records)) {
      const folder = skillFolder(libraryDir, record.name);
      const hash = await folderHash(folder).catch(() => null);
      if (!record.installedHash && hash) record.installedHash = hash;
      // No record of which version was installed: the folder's own Git tree id tells,
      // so an unchanged copy matches the remote instead of always looking outdated.
      if (!record.installedTree && hash) {
        record.installedTree = await gitTreeId(folder).catch(() => null);
      }
      out.push(toView(record, hash));
    }
    return out;
  });
  return views.sort((left, right) => left.name.localeCompare(right.name));
}

export async function setSkillSource(
  libraryDir: string,
  name: string,
  url: string
): Promise<SkillSourceView> {
  const folder = skillFolder(libraryDir, name);
  const parsed = parseGitHubSkillUrl(url);
  if (!parsed)
    throw new Error('Paste a GitHub link, like https://github.com/owner/repo/tree/main/path');
  const resolved = await resolveRefAndPath(parsed);
  const hash = await folderHash(folder).catch(() => null);
  const localTree = hash ? await gitTreeId(folder).catch(() => null) : null;
  return mutateSources(libraryDir, (records) => {
    const previous = records[name];
    const sameSource =
      previous?.repo === resolved.repo &&
      previous.ref === resolved.ref &&
      previous.path === resolved.path;
    records[name] = {
      name,
      ...resolved,
      installedTree: (sameSource ? previous.installedTree : null) ?? localTree,
      remoteTree: null,
      installedHash: hash,
    };
    return toView(records[name], hash);
  });
}

export async function checkSkillUpdates(libraryDir: string): Promise<SkillSourceView[]> {
  const records = await mutateSources(libraryDir, async (current) => {
    await importKnownSources(libraryDir, current);
    return Object.values(current).map((record) => ({ ...record }));
  });
  const byRepo = new Map<string, SkillSourceRecord[]>();
  for (const record of records) {
    const group = byRepo.get(`${record.repo}@${record.ref}`) ?? [];
    group.push(record);
    byRepo.set(`${record.repo}@${record.ref}`, group);
  }
  const results = await Promise.allSettled(
    [...byRepo.values()].map(async (group) => {
      const first = group[0];
      if (!first) return [];
      const snapshot = await remoteSnapshot(first.repo, first.ref);
      return group.map((record) => ({ record, tree: treeAt(snapshot, record.path) }));
    })
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure && results.every((result) => result.status === 'rejected')) {
    throw failure.reason;
  }
  await mutateSources(libraryDir, (current) => {
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const { record, tree } of result.value) {
        const stored = current[record.name];
        if (tree && stored && stored.repo === record.repo && stored.ref === record.ref) {
          stored.remoteTree = tree;
        }
      }
    }
  });
  return listSkillSources(libraryDir);
}

export async function updateSkill(
  libraryDir: string,
  name: string,
  force: boolean
): Promise<{ updated: boolean; dirty: boolean; files: string[] }> {
  const folder = skillFolder(libraryDir, name);
  const record = await mutateSources(libraryDir, (records) =>
    records[name] ? { ...records[name] } : null
  );
  if (!record) throw new Error(`No source is set for ${name}`);
  const hash = await folderHash(folder).catch(() => null);
  const dirty = Boolean(record.installedHash && hash && hash !== record.installedHash);
  const snapshot = await remoteSnapshot(record.repo, record.ref);
  const tree = treeAt(snapshot, record.path);
  const files = filesUnder(snapshot, record.path);
  const names = files.map((file) => file.path);
  if (!tree || files.length === 0) throw new Error(`No files found in ${record.repo}`);
  if (dirty && !force) return { updated: false, dirty: true, files: names };
  const updateRoot = path.join(libraryDir, UPDATE_DIR);
  await mkdir(updateRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(updateRoot, `${name}-`));
  try {
    const download = path.join(scratch, 'download');
    for (const file of files) {
      const target = remoteFileTarget(download, file.path);
      const response = await fetch(
        `https://raw.githubusercontent.com/${record.repo}/${snapshot.commit}/${encodePath(record.path ? `${record.path}/${file.path}` : file.path)}`,
        { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'emdash' } }
      );
      if (!response.ok) throw new Error(`Could not download ${file.path} (${response.status})`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
      // Scripts stay runnable (and the folder's Git tree id matches the remote's).
      if (file.mode === '100755') await chmod(target, 0o755);
    }
    return await mutateSources(libraryDir, async (records) => {
      await replaceFolder(download, folder, path.join(scratch, 'previous'));
      const stored = records[name];
      if (stored) {
        stored.installedHash = await folderHash(folder);
        stored.installedTree = tree;
        stored.remoteTree = tree;
      }
      return { updated: true, dirty: false, files: names };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function toView(record: SkillSourceRecord, hash: string | null): SkillSourceView {
  const dirty = Boolean(record.installedHash && hash && hash !== record.installedHash);
  return {
    ...record,
    dirty,
    updateAvailable: Boolean(record.remoteTree && record.remoteTree !== record.installedTree),
  };
}

/** Moves `next` into `target`, putting the old folder back if that fails. */
async function replaceFolder(next: string, target: string, backup: string): Promise<void> {
  const hadPrevious = await rename(target, backup).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
  try {
    await rename(next, target);
  } catch (error) {
    if (hadPrevious) await rename(backup, target);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

let sourcesQueue: Promise<unknown> = Promise.resolve();

/** Read-modify-write of sources.json, one at a time; writes only when something changed. */
function mutateSources<T>(
  libraryDir: string,
  change: (records: Record<string, SkillSourceRecord>) => T | Promise<T>
): Promise<T> {
  const run = async () => {
    const records = await readSources(libraryDir);
    const before = JSON.stringify(records);
    const result = await change(records);
    if (JSON.stringify(records) !== before) await writeSources(libraryDir, records);
    return result;
  };
  const next = sourcesQueue.then(run, run);
  sourcesQueue = next.catch(() => {});
  return next;
}

async function readSources(libraryDir: string): Promise<Record<string, SkillSourceRecord>> {
  const raw = await readFile(path.join(libraryDir, SOURCES_FILE), 'utf8').catch(() => '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { skills?: Record<string, SkillSourceRecord> };
    return Object.fromEntries(
      Object.entries(parsed.skills ?? {})
        .filter(([name]) => isSafeSkillName(name))
        .map(([name, record]) => [name, { ...record, name }])
    );
  } catch {
    return {};
  }
}

async function writeSources(
  libraryDir: string,
  skills: Record<string, SkillSourceRecord>
): Promise<void> {
  const file = path.join(libraryDir, SOURCES_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify({ skills }, null, 2));
  await rename(temp, file);
}

async function importKnownSources(
  libraryDir: string,
  records: Record<string, SkillSourceRecord>
): Promise<void> {
  const installs = await readJson(path.join(libraryDir, '.emdash', 'skillssh-installs.json'));
  for (const [name, value] of Object.entries(installs)) {
    if (records[name] || !isSafeSkillName(name)) continue;
    const row = value as { sourceRef?: string; skillShPath?: string };
    if (!row.sourceRef) continue;
    records[name] = blank(name, row.sourceRef, dirnamePosix(row.skillShPath ?? ''), 'HEAD');
  }
  const lock = await readJson(path.join(libraryDir, '..', '.agents', '.skill-lock.json'));
  const locked = (lock.skills ?? {}) as Record<
    string,
    { source?: string; skillPath?: string; skillFolderHash?: string }
  >;
  for (const [name, row] of Object.entries(locked)) {
    if (records[name] || !row.source || !isSafeSkillName(name)) continue;
    records[name] = {
      ...blank(name, row.source, dirnamePosix(row.skillPath ?? ''), 'HEAD'),
      installedTree: row.skillFolderHash ?? null,
    };
  }
  const entries = await readdir(libraryDir).catch(() => [] as string[]);
  for (const name of entries) {
    if (records[name] || !isSafeSkillName(name)) continue;
    const release = await readJson(path.join(libraryDir, name, 'skill-release.json'));
    const repository = (release.source as { repository?: string } | undefined)?.repository;
    const parsed = repository ? parseGitHubSkillUrl(repository) : null;
    if (!parsed) continue;
    records[name] = blank(name, parsed.repo, parsed.path, parsed.ref);
  }
}

function blank(name: string, repo: string, skillPath: string, ref: string): SkillSourceRecord {
  return {
    name,
    repo,
    path: skillPath,
    ref,
    installedTree: null,
    remoteTree: null,
    installedHash: null,
  };
}

/** The shortest leading run of segments GitHub knows as a ref; branch names can hold `/`. */
async function resolveRefAndPath(
  parsed: Pick<SkillSourceRecord, 'repo' | 'path' | 'ref'>
): Promise<Pick<SkillSourceRecord, 'repo' | 'path' | 'ref'>> {
  if (parsed.ref === 'HEAD' || !parsed.path) return parsed;
  const segments = [parsed.ref, ...parsed.path.split('/')];
  for (let count = 1; count <= segments.length; count++) {
    const ref = segments.slice(0, count).join('/');
    const commit = await fetchGitHub(
      `https://api.github.com/repos/${parsed.repo}/commits/${encodeURIComponent(ref)}`,
      { missingOk: true }
    );
    if (commit) return { repo: parsed.repo, ref, path: segments.slice(count).join('/') };
  }
  return parsed;
}

async function remoteSnapshot(repo: string, ref: string): Promise<RemoteSnapshot> {
  const branch = ref === 'HEAD' ? await defaultBranch(repo) : ref;
  const commit = await fetchGitHub(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`
  );
  const commitSha = typeof commit?.sha === 'string' ? commit.sha : null;
  const rootTree = (commit?.commit as { tree?: { sha?: string } } | undefined)?.tree?.sha;
  if (!commitSha || !rootTree) throw new Error(`Could not read ${branch} in ${repo}`);
  const body = await fetchGitHub(
    `https://api.github.com/repos/${repo}/git/trees/${rootTree}?recursive=1`
  );
  if (body?.truncated === true) {
    throw new Error(`${repo} has too many files for GitHub to list in one request`);
  }
  const list = Array.isArray(body?.tree) ? body.tree : [];
  return {
    commit: commitSha,
    rootTree,
    entries: list.flatMap((entry) => {
      const row = entry as { path?: unknown; type?: unknown; sha?: unknown; mode?: unknown };
      return typeof row.path === 'string' && typeof row.type === 'string'
        ? [
            {
              path: row.path,
              type: row.type,
              sha: typeof row.sha === 'string' ? row.sha : null,
              mode: typeof row.mode === 'string' ? row.mode : null,
            },
          ]
        : [];
    }),
  };
}

function treeAt(snapshot: RemoteSnapshot, treePath: string): string | null {
  if (!treePath) return snapshot.rootTree;
  return (
    snapshot.entries.find((entry) => entry.type === 'tree' && entry.path === treePath)?.sha ?? null
  );
}

function filesUnder(
  snapshot: RemoteSnapshot,
  treePath: string
): { path: string; mode: string | null }[] {
  const prefix = treePath ? `${treePath}/` : '';
  return snapshot.entries.flatMap((entry) => {
    if (entry.type !== 'blob') return [];
    if (prefix && !entry.path.startsWith(prefix)) return [];
    const relative = entry.path.slice(prefix.length);
    return relative ? [{ path: relative, mode: entry.mode }] : [];
  });
}

/** Files Git would not have put there; they do not count toward a folder's tree id. */
const NOT_IN_GIT = new Set(['.git', '.DS_Store']);

/**
 * The Git tree id (`git write-tree` of the folder alone): what GitHub reports for the same
 * content, so a local copy compares with the remote without a record of what was installed.
 */
export async function gitTreeId(dir: string): Promise<string> {
  const id = await treeId(dir);
  // An empty folder: Git's empty tree.
  return id ?? gitObjectId('tree', Buffer.alloc(0)).toString('hex');
}

async function treeId(dir: string): Promise<string | null> {
  const rows: { name: string; sortKey: string; mode: string; id: Buffer }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (NOT_IN_GIT.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const id = await treeId(full);
      // Git has no empty folders.
      if (id) {
        rows.push({
          name: entry.name,
          sortKey: `${entry.name}/`,
          mode: '40000',
          id: Buffer.from(id, 'hex'),
        });
      }
    } else if (entry.isSymbolicLink()) {
      const target = Buffer.from(await readlink(full));
      rows.push({ name: entry.name, sortKey: entry.name, mode: '120000', id: blobId(target) });
    } else if (entry.isFile()) {
      const executable = ((await lstat(full)).mode & 0o111) !== 0;
      rows.push({
        name: entry.name,
        sortKey: entry.name,
        mode: executable ? '100755' : '100644',
        id: blobId(await readFile(full)),
      });
    }
  }
  if (rows.length === 0) return null;
  rows.sort((left, right) => Buffer.compare(Buffer.from(left.sortKey), Buffer.from(right.sortKey)));
  const body = Buffer.concat(
    rows.flatMap((row) => [Buffer.from(`${row.mode} ${row.name}\0`), row.id])
  );
  return gitObjectId('tree', body).toString('hex');
}

function blobId(content: Buffer): Buffer {
  return gitObjectId('blob', content);
}

function gitObjectId(type: 'blob' | 'tree', content: Buffer): Buffer {
  return createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest();
}

const branches = new Map<string, string>();

async function defaultBranch(repo: string): Promise<string> {
  const cached = branches.get(repo);
  if (cached) return cached;
  const body = await fetchGitHub(`https://api.github.com/repos/${repo}`);
  const branch = typeof body?.default_branch === 'string' ? body.default_branch : 'main';
  branches.set(repo, branch);
  return branch;
}

/** Content hash of a skill folder (dot-files excluded), for change detection. */
export async function folderHash(dir: string): Promise<string> {
  const files = await walk(dir, dir);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(file);
    hash.update(await readFile(path.join(dir, file)));
  }
  return hash.digest('hex');
}

async function walk(dir: string, root: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, root)));
    else if (entry.isFile()) files.push(path.relative(root, full));
  }
  return files;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8').catch(() => '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Throws on HTTP errors; with `missingOk`, a 404 or 422 (unknown ref) is null instead. */
async function fetchGitHub(
  url: string,
  options: { missingOk?: boolean } = {}
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'emdash' },
    });
  } catch (error) {
    throw new Error(
      `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    if (options.missingOk && (response.status === 404 || response.status === 422)) return null;
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      throw new Error('GitHub rate limit reached; try again later');
    }
    throw new Error(`GitHub returned ${response.status} for ${new URL(url).pathname}`);
  }
  const body = (await response.json()) as unknown;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

function dirnamePosix(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

function encodePath(file: string): string {
  return file.split('/').map(encodeURIComponent).join('/');
}
