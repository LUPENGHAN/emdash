import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSkillUpdates,
  gitTreeId,
  importLocalSkills,
  installGitHubSkills,
  isSafeSkillName,
  listSkillSources,
  parseGitHubSkillUrl,
  remoteFileTarget,
  scanGitHubSkills,
  setSkillSource,
  skillFolder,
  updateSkill,
} from './skill-sources';

describe('parseGitHubSkillUrl', () => {
  it('reads a tree link', () => {
    expect(
      parseGitHubSkillUrl('https://github.com/vercel-labs/skills/tree/main/skills/find-skills')
    ).toEqual({
      repo: 'vercel-labs/skills',
      ref: 'main',
      path: 'skills/find-skills',
    });
  });

  it('reads a repository link as the root on the default branch', () => {
    expect(parseGitHubSkillUrl('https://github.com/tt-a1i/archify')).toEqual({
      repo: 'tt-a1i/archify',
      ref: 'HEAD',
      path: '',
    });
  });

  it('rejects a non-github link', () => {
    expect(parseGitHubSkillUrl('https://example.com/owner/repo')).toBeNull();
  });
});

describe('gitTreeId', () => {
  it('matches the tree Git writes for the same folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-tree-'));
    try {
      await mkdir(path.join(dir, 'scripts'));
      await mkdir(path.join(dir, 'empty'));
      await mkdir(path.join(dir, 'a-b'));
      await writeFile(path.join(dir, 'SKILL.md'), '# Demo\n');
      await writeFile(path.join(dir, 'a.md'), 'a');
      await writeFile(path.join(dir, 'a-b', 'x.md'), 'x');
      await writeFile(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
      await writeFile(path.join(dir, '.DS_Store'), 'junk');
      if (process.platform !== 'win32') {
        await chmod(path.join(dir, 'scripts', 'run.sh'), 0o755);
        await symlink('SKILL.md', path.join(dir, 'link.md'));
      }
      const local = await gitTreeId(dir);
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('add', '--all', '--', '.', ':!.DS_Store');
      expect(local).toBe(git('write-tree'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('skill name and path safety', () => {
  it('accepts one plain folder name only', () => {
    expect(isSafeSkillName('find-skills')).toBe(true);
    expect(isSafeSkillName('v1.2_x')).toBe(true);
    for (const name of ['', '.', '..', '.emdash', 'a/b', '../x', 'a\\b', 'a b']) {
      expect(isSafeSkillName(name)).toBe(false);
    }
    expect(() => skillFolder('/lib', '..')).toThrow();
    expect(skillFolder('/lib', 'ok')).toBe(path.resolve('/lib', 'ok'));
  });

  it('keeps remote files inside the target folder', () => {
    expect(remoteFileTarget('/scratch', 'a/b.md')).toBe(path.resolve('/scratch', 'a', 'b.md'));
    for (const file of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'a//b', './a', 'a\\..\\b']) {
      expect(() => remoteFileTarget('/scratch', file)).toThrow();
    }
  });
});

describe('updateSkill', () => {
  let home: string;
  let libraryDir: string;
  let requests: { url: string; authorization?: string }[];
  let blobs: Record<string, string>;
  let tree: { path: string; type: string; sha?: string; mode?: string }[];
  let truncated: boolean;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'skill-sources-'));
    libraryDir = path.join(home, '.agentskills');
    await mkdir(path.join(libraryDir, 'demo'), { recursive: true });
    await writeFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'old');
    truncated = false;
    requests = [];
    blobs = { 'sha-skill': 'new SKILL.md', 'sha-guide': 'new guide' };
    tree = [
      { path: 'skills', type: 'tree', sha: 'tree-skills' },
      { path: 'skills/demo', type: 'tree', sha: 'tree-demo' },
      { path: 'skills/demo/SKILL.md', type: 'blob', sha: 'sha-skill' },
      { path: 'skills/demo/docs/guide.md', type: 'blob', sha: 'sha-guide' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ url: url.toString(), authorization: headers.authorization });
        if (url.pathname === '/repos/o/r/commits/main') {
          return Response.json({ sha: 'commit-1', commit: { tree: { sha: 'root' } } });
        }
        if (url.pathname === '/repos/o/r/commits/commit-1') {
          return Response.json({ sha: 'commit-1', commit: { tree: { sha: 'root' } } });
        }
        if (url.pathname.startsWith('/repos/o/r/commits/')) {
          return new Response('{}', { status: 422 });
        }
        if (url.pathname === '/repos/o/r') {
          return Response.json({ default_branch: 'main' });
        }
        if (url.pathname === '/repos/o/r/git/trees/root') {
          return Response.json({ tree, truncated });
        }
        if (url.hostname === 'raw.githubusercontent.com') {
          const repoPath = decodeURIComponent(url.pathname.replace(/^\/o\/r\/commit-1\//, ''));
          const sha = tree.find((entry) => entry.path === repoPath)?.sha;
          const content = sha ? blobs[sha] : undefined;
          return content === undefined ? new Response('', { status: 404 }) : new Response(content);
        }
        const blob = /^\/repos\/o\/r\/git\/blobs\/([^/]+)$/.exec(url.pathname);
        if (blob) {
          const content = blobs[blob[1]!];
          return content === undefined
            ? new Response('{}', { status: 404 })
            : Response.json({
                encoding: 'base64',
                content: Buffer.from(content, 'utf8').toString('base64'),
              });
        }
        return new Response('{}', { status: 404 });
      })
    );
    await setSkillSource(libraryDir, 'demo', 'https://github.com/o/r/tree/main/skills/demo');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('replaces the folder with the downloaded tree and records its sha', async () => {
    const result = await updateSkill(libraryDir, 'demo', false);
    expect(result).toMatchObject({
      updated: true,
      dirty: false,
      files: ['SKILL.md', 'docs/guide.md'],
    });
    expect(result.source).toMatchObject({
      name: 'demo',
      installedTree: 'tree-demo',
      remoteTree: 'tree-demo',
      updateAvailable: false,
      dirty: false,
    });
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe('new SKILL.md');
    const sources = JSON.parse(
      await readFile(path.join(libraryDir, '.emdash', 'sources.json'), 'utf8')
    ) as { skills: Record<string, { installedTree: string; ref: string; path: string }> };
    expect(sources.skills.demo).toMatchObject({
      installedTree: 'tree-demo',
      ref: 'main',
      path: 'skills/demo',
    });
  });

  it('flags an update only when the remote folder differs from the local copy', async () => {
    const local = await gitTreeId(path.join(libraryDir, 'demo'));
    tree[1] = { path: 'skills/demo', type: 'tree', sha: local };
    expect((await checkSkillUpdates(libraryDir))[0]).toMatchObject({
      installedTree: local,
      updateAvailable: false,
    });
    tree[1] = { path: 'skills/demo', type: 'tree', sha: 'tree-newer' };
    expect((await checkSkillUpdates(libraryDir))[0]?.updateAvailable).toBe(true);
  });

  it('asks before replacing local edits', async () => {
    await writeFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'edited');
    expect(await updateSkill(libraryDir, 'demo', false)).toMatchObject({
      updated: false,
      dirty: true,
    });
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe('edited');
  });

  it('leaves the folder alone when the remote tree escapes it', async () => {
    tree.push({ path: 'skills/demo/../../evil.md', type: 'blob', sha: 'sha-evil' });
    await expect(updateSkill(libraryDir, 'demo', false)).rejects.toThrow(/outside/);
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe('old');
  });

  it('fails on a truncated tree listing', async () => {
    truncated = true;
    await expect(updateSkill(libraryDir, 'demo', false)).rejects.toThrow(/too many files/);
  });

  it('rejects an unsafe skill name', async () => {
    await expect(updateSkill(libraryDir, '..', true)).rejects.toThrow(/not a valid skill name/);
    await expect(
      setSkillSource(libraryDir, '../x', 'https://github.com/o/r/tree/main/skills/demo')
    ).rejects.toThrow(/not a valid skill name/);
  });

  it('sends the account token only when there is one', async () => {
    requests.length = 0;
    await checkSkillUpdates(libraryDir, 'tok-1');
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.authorization).toBe('Bearer tok-1');
    }
    requests.length = 0;
    await checkSkillUpdates(libraryDir, null);
    for (const request of requests) {
      expect(request.authorization).toBeUndefined();
    }
  });

  it('downloads files from raw URLs without a token, from the blobs API with one', async () => {
    // Anonymous API calls are capped at 60 an hour; one per file would use them up.
    requests.length = 0;
    await updateSkill(libraryDir, 'demo', true);
    const anonymous = requests.map((request) => request.url);
    expect(anonymous.filter((url) => url.includes('/git/blobs/'))).toEqual([]);
    expect(anonymous).toContain(
      'https://raw.githubusercontent.com/o/r/commit-1/skills/demo/SKILL.md'
    );

    tree[1] = { path: 'skills/demo', type: 'tree', sha: 'tree-demo-2' };
    requests.length = 0;
    await updateSkill(libraryDir, 'demo', true, 'tok-1');
    const signedIn = requests.map((request) => request.url);
    expect(signedIn.filter((url) => url.includes('raw.githubusercontent.com'))).toEqual([]);
    expect(signedIn.filter((url) => url.includes('/git/blobs/'))).toHaveLength(2);
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe('new SKILL.md');
  });

  it('records the remote tree and does not download when the copy is already current', async () => {
    const local = await gitTreeId(path.join(libraryDir, 'demo'));
    tree[1] = { path: 'skills/demo', type: 'tree', sha: local };
    requests.length = 0;
    const result = await updateSkill(libraryDir, 'demo', false);
    expect(result).toMatchObject({ updated: false, dirty: false, files: [] });
    expect(result.source).toMatchObject({
      remoteTree: local,
      installedTree: local,
      updateAvailable: false,
    });
    expect(requests.some((request) => request.url.includes('raw.githubusercontent.com'))).toBe(
      false
    );
    expect(requests.some((request) => request.url.includes('/git/blobs/'))).toBe(false);
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe('old');
    const sources = JSON.parse(
      await readFile(path.join(libraryDir, '.emdash', 'sources.json'), 'utf8')
    ) as { skills: Record<string, { remoteTree: string }> };
    expect(sources.skills.demo?.remoteTree).toBe(local);

    requests.length = 0;
    const again = await updateSkill(libraryDir, 'demo', false);
    expect(again.updated).toBe(false);
    expect(requests.some((request) => request.url.includes('raw.githubusercontent.com'))).toBe(
      false
    );
  });

  it('writes the checked tree when installedTree is filled in during the request', async () => {
    const sourcesPath = path.join(libraryDir, '.emdash', 'sources.json');
    const parsed = JSON.parse(await readFile(sourcesPath, 'utf8')) as {
      skills: Record<string, { installedTree: string | null }>;
    };
    const demo = parsed.skills.demo;
    if (!demo) throw new Error('missing demo source');
    demo.installedTree = null;
    await writeFile(sourcesPath, JSON.stringify(parsed));

    const inner = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened!: () => void;
    const entered = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let held = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (!held && url.pathname === '/repos/o/r/git/trees/root') {
          held = true;
          opened();
          await gate;
        }
        return inner(input, init);
      })
    );

    const pending = checkSkillUpdates(libraryDir);
    await entered;
    await listSkillSources(libraryDir);
    release();
    const views = await pending;
    expect(views.find((view) => view.name === 'demo')).toMatchObject({
      remoteTree: 'tree-demo',
      updateAvailable: true,
    });
    const stored = JSON.parse(await readFile(sourcesPath, 'utf8')) as {
      skills: Record<string, { installedTree: string | null; remoteTree: string | null }>;
    };
    expect(stored.skills.demo?.installedTree).toEqual(expect.any(String));
    expect(stored.skills.demo?.remoteTree).toBe('tree-demo');
  });

  it('does not write an older remote tree over an update that finished during the check', async () => {
    const inner = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened!: () => void;
    const entered = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let held = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (!held && url.pathname === '/repos/o/r/git/trees/root') {
          held = true;
          const response = await inner(input, init);
          opened();
          await gate;
          return response;
        }
        return inner(input, init);
      })
    );

    const pending = checkSkillUpdates(libraryDir);
    await entered;
    tree[1] = { path: 'skills/demo', type: 'tree', sha: 'tree-updated' };
    await updateSkill(libraryDir, 'demo', false);
    release();
    const views = await pending;
    expect(views.find((view) => view.name === 'demo')).toMatchObject({
      installedTree: 'tree-updated',
      remoteTree: 'tree-updated',
      updateAvailable: false,
    });
  });

  it('leaves another skill on the same repo untouched', async () => {
    await mkdir(path.join(libraryDir, 'demo-2'), { recursive: true });
    await writeFile(path.join(libraryDir, 'demo-2', 'SKILL.md'), 'other');
    await setSkillSource(libraryDir, 'demo-2', 'https://github.com/o/r/tree/main/skills/demo');
    const before = (await listSkillSources(libraryDir)).find((view) => view.name === 'demo-2');
    await updateSkill(libraryDir, 'demo', false);
    const after = (await listSkillSources(libraryDir)).find((view) => view.name === 'demo-2');
    expect(after?.installedTree).toBe(before?.installedTree);
    expect(after?.remoteTree).toBe(before?.remoteTree);
  });

  it('does not download an already-current skill after another skill is imported', async () => {
    const local = await gitTreeId(path.join(libraryDir, 'demo'));
    tree[1] = { path: 'skills/demo', type: 'tree', sha: local };
    await updateSkill(libraryDir, 'demo', false);
    const source = path.join(home, 'ship-note');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: ship-note\n---\nnote\n');
    requests.length = 0;
    await importLocalSkills(libraryDir, {
      sourcePath: source,
      cwd: null,
      overwrite: false,
      apply: true,
    });
    expect(requests).toEqual([]);
    requests.length = 0;
    const result = await updateSkill(libraryDir, 'demo', false);
    expect(result).toMatchObject({ updated: false, dirty: false, files: [] });
    expect(requests.some((request) => request.url.includes('raw.githubusercontent.com'))).toBe(
      false
    );
    expect(requests.some((request) => request.url.includes('/git/blobs/'))).toBe(false);
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe('old');
    expect(await readFile(path.join(libraryDir, 'ship-note', 'SKILL.md'), 'utf8')).toContain(
      'note'
    );
  });

  it('keeps a GitHub skill dirty after import and still names the remote files', async () => {
    const sourcesPath = path.join(libraryDir, '.emdash', 'sources.json');
    const before = await readFile(sourcesPath, 'utf8');
    const source = path.join(home, 'replacement');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: demo\n---\nimported body\n');
    await importLocalSkills(libraryDir, {
      sourcePath: source,
      cwd: null,
      overwrite: true,
      apply: true,
    });
    expect(await readFile(sourcesPath, 'utf8')).toBe(before);
    requests.length = 0;
    const result = await updateSkill(libraryDir, 'demo', false);
    expect(result).toMatchObject({
      updated: false,
      dirty: true,
      files: ['SKILL.md', 'docs/guide.md'],
    });
    expect(requests.some((request) => request.url.includes('api.github.com'))).toBe(true);
    expect(requests.some((request) => request.url.includes('raw.githubusercontent.com'))).toBe(
      false
    );
    expect(requests.some((request) => request.url.includes('/git/blobs/'))).toBe(false);
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toContain(
      'imported body'
    );
    expect(await readFile(sourcesPath, 'utf8')).toBe(before);
  });
});

type StubEntry = { path: string; type: string; sha?: string; mode?: string };

/** Stubs api.github.com: the repo, commits, one recursive tree, and blobs. */
function stubGitHub(input: {
  tree: StubEntry[];
  blobs: Record<string, string>;
  truncated?: boolean;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (urlText: string) => {
      const url = new URL(urlText);
      if (url.pathname === '/repos/o/r') return Response.json({ default_branch: 'main' });
      if (url.pathname === '/repos/o/r/commits/main') {
        return Response.json({ sha: 'commit-1', commit: { tree: { sha: 'root' } } });
      }
      if (url.pathname === '/repos/o/r/commits/commit-1') {
        return Response.json({ sha: 'commit-1', commit: { tree: { sha: 'root' } } });
      }
      if (url.pathname === '/repos/o/r/git/trees/root') {
        return Response.json({ tree: input.tree, truncated: input.truncated ?? false });
      }
      if (url.hostname === 'raw.githubusercontent.com') {
        const repoPath = decodeURIComponent(url.pathname.replace(/^\/o\/r\/commit-1\//, ''));
        const sha = input.tree.find((entry) => entry.path === repoPath)?.sha;
        const content = sha ? input.blobs[sha] : undefined;
        return content === undefined ? new Response('', { status: 404 }) : new Response(content);
      }
      const blob = /^\/repos\/o\/r\/git\/blobs\/([^/]+)$/.exec(url.pathname);
      if (blob) {
        const content = input.blobs[blob[1]!];
        return content === undefined
          ? new Response('{}', { status: 404 })
          : Response.json({
              encoding: 'base64',
              content: Buffer.from(content, 'utf8').toString('base64'),
            });
      }
      return new Response('{}', { status: 404 });
    })
  );
}

const skillMd = (name: string | null, description: string) =>
  name === null
    ? `---\ndescription: ${description}\n---\nBody\n`
    : `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;

describe('scanGitHubSkills', () => {
  let home: string;
  let libraryDir: string;
  let tree: StubEntry[];
  const blobs: Record<string, string> = {
    'b-root': skillMd('rooty', 'The repository root skill'),
    'b-cust': skillMd('customer-analysis', 'Analyzes customers'),
    'b-outer': skillMd(null, 'No name in frontmatter'),
    'b-inner': skillMd('inner', 'Nested'),
    'b-weird': skillMd('bad name!', 'Weird'),
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'skill-scan-'));
    libraryDir = path.join(home, '.agentskills');
    // A skill the library already has under the same name.
    await mkdir(path.join(libraryDir, 'customer-analysis'), { recursive: true });
    await writeFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'existing');
    tree = [
      { path: '.agents/skills/customer-analysis', type: 'tree', sha: 't-cust' },
      { path: '.agents/skills/customer-analysis/SKILL.md', type: 'blob', sha: 'b-cust' },
      {
        path: '.agents/skills/customer-analysis/linked.md',
        type: 'blob',
        sha: 'b-link',
        mode: '120000',
      },
      { path: 'tools/outer', type: 'tree', sha: 't-outer' },
      { path: 'tools/outer/SKILL.md', type: 'blob', sha: 'b-outer' },
      { path: 'tools/outer/inner/SKILL.md', type: 'blob', sha: 'b-inner' },
      { path: 'weird name/SKILL.md', type: 'blob', sha: 'b-weird' },
    ];
    stubGitHub({ tree, blobs });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('lists the outermost skills with names from frontmatter or the folder', async () => {
    const result = await scanGitHubSkills(libraryDir, 'https://github.com/o/r', null);
    expect(result).toMatchObject({ repo: 'o/r', ref: 'HEAD', commit: 'commit-1' });
    expect(result.truncated).toBe(false);
    expect(result.skills).toEqual([
      {
        path: '.agents/skills/customer-analysis',
        name: 'customer-analysis',
        description: 'Analyzes customers',
        valid: true,
        existsInLibrary: true,
        skipped: ['linked.md'],
      },
      {
        path: 'tools/outer',
        name: 'outer',
        description: 'No name in frontmatter',
        valid: true,
        existsInLibrary: false,
        skipped: [],
      },
      {
        path: 'weird name',
        name: 'bad name!',
        description: 'Weird',
        valid: false,
        existsInLibrary: false,
        skipped: [],
      },
    ]);
  });

  it('treats the repository root as one skill when it holds a SKILL.md', async () => {
    const result = await scanGitHubSkills(libraryDir, 'https://github.com/o/r', null);
    stubGitHub({
      tree: [{ path: 'SKILL.md', type: 'blob', sha: 'b-root' }, ...tree],
      blobs,
    });
    const rooted = await scanGitHubSkills(libraryDir, 'https://github.com/o/r', null);
    expect(result.skills.length).toBeGreaterThan(1);
    expect(rooted.skills).toEqual([
      {
        path: '',
        name: 'rooty',
        description: 'The repository root skill',
        valid: true,
        existsInLibrary: false,
        skipped: ['.agents/skills/customer-analysis/linked.md'],
      },
    ]);
  });

  it('throws when the linked folder holds no SKILL.md', async () => {
    await expect(
      scanGitHubSkills(libraryDir, 'https://github.com/o/r/tree/main/docs', null)
    ).rejects.toThrow(/No SKILL.md found under o\/r\/docs/);
  });

  it('caps the list at fifty skills', async () => {
    tree = Array.from({ length: 60 }, (_, index) => ({
      path: `skill-${String(index).padStart(2, '0')}/SKILL.md`,
      type: 'blob',
      sha: 'b-root',
    }));
    stubGitHub({ tree, blobs });
    const result = await scanGitHubSkills(libraryDir, 'https://github.com/o/r', null);
    expect(result.truncated).toBe(true);
    expect(result.skills).toHaveLength(50);
  });

  it('names a private-looking 404 differently before and after signing in', async () => {
    await expect(
      scanGitHubSkills(libraryDir, 'https://github.com/o/missing', null)
    ).rejects.toThrow(/sign in to GitHub in Settings → Accounts/);
    await expect(
      scanGitHubSkills(libraryDir, 'https://github.com/o/missing', 'tok-1')
    ).rejects.toThrow(/cannot see it/);
  });
});

describe('installGitHubSkills', () => {
  let home: string;
  let libraryDir: string;
  const blobs: Record<string, string> = {
    'b-cust': skillMd('customer-analysis', 'Analyzes customers'),
    'b-notes': 'notes body',
  };
  const tree: StubEntry[] = [
    { path: '.agents/skills/customer-analysis', type: 'tree', sha: 't-cust' },
    { path: '.agents/skills/customer-analysis/SKILL.md', type: 'blob', sha: 'b-cust' },
    {
      path: '.agents/skills/customer-analysis/notes.md',
      type: 'blob',
      sha: 'b-notes',
      mode: '100755',
    },
    {
      path: '.agents/skills/customer-analysis/linked.md',
      type: 'blob',
      sha: 'b-link',
      mode: '120000',
    },
  ];
  const picks = { path: '.agents/skills/customer-analysis', name: 'customer-analysis' };

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'skill-install-'));
    libraryDir = path.join(home, '.agentskills');
    stubGitHub({ tree, blobs });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('installs at the scanned commit, without symlinks, and records the source', async () => {
    const result = await installGitHubSkills(
      libraryDir,
      {
        repo: 'o/r',
        ref: 'main',
        commit: 'commit-1',
        picks: [{ ...picks, overwrite: false }],
      },
      null
    );
    expect(result.installed).toEqual(['customer-analysis']);
    expect(result.skipped).toEqual([]);
    const folder = path.join(libraryDir, 'customer-analysis');
    expect(await readFile(path.join(folder, 'SKILL.md'), 'utf8')).toContain(
      'name: customer-analysis'
    );
    expect(await readFile(path.join(folder, 'notes.md'), 'utf8')).toBe('notes body');
    // Symlinks are not copied.
    await expect(readFile(path.join(folder, 'linked.md'))).rejects.toThrow();
    const sources = JSON.parse(
      await readFile(path.join(libraryDir, '.emdash', 'sources.json'), 'utf8')
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(sources.skills['customer-analysis']).toMatchObject({
      repo: 'o/r',
      path: '.agents/skills/customer-analysis',
      ref: 'main',
      installedTree: 't-cust',
      remoteTree: 't-cust',
    });
    expect(sources.skills['customer-analysis']?.installedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips a name the library already has unless overwrite is set', async () => {
    await mkdir(path.join(libraryDir, 'customer-analysis'), { recursive: true });
    await writeFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'existing');
    const refused = await installGitHubSkills(
      libraryDir,
      {
        repo: 'o/r',
        ref: 'main',
        commit: 'commit-1',
        picks: [{ ...picks, overwrite: false }],
      },
      null
    );
    expect(refused).toEqual({
      installed: [],
      skipped: [{ name: 'customer-analysis', reason: 'already in the library' }],
    });
    expect(await readFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'utf8')).toBe(
      'existing'
    );
    const replaced = await installGitHubSkills(
      libraryDir,
      {
        repo: 'o/r',
        ref: 'main',
        commit: 'commit-1',
        picks: [{ ...picks, overwrite: true }],
      },
      null
    );
    expect(replaced.installed).toEqual(['customer-analysis']);
  });

  it('skips an overwrite of a skill with local edits', async () => {
    await mkdir(path.join(libraryDir, 'customer-analysis'), { recursive: true });
    await writeFile(
      path.join(libraryDir, 'customer-analysis', 'SKILL.md'),
      skillMd('customer-analysis', 'local copy')
    );
    await setSkillSource(
      libraryDir,
      'customer-analysis',
      'https://github.com/o/r/tree/main/.agents/skills/customer-analysis'
    );
    await writeFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'edited');
    const result = await installGitHubSkills(
      libraryDir,
      {
        repo: 'o/r',
        ref: 'main',
        commit: 'commit-1',
        picks: [{ ...picks, overwrite: true }],
      },
      null
    );
    expect(result.skipped).toEqual([{ name: 'customer-analysis', reason: 'has local edits' }]);
    expect(await readFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'utf8')).toBe(
      'edited'
    );
  });

  it('skips invalid names and keeps installing the others', async () => {
    const result = await installGitHubSkills(
      libraryDir,
      {
        repo: 'o/r',
        ref: 'main',
        commit: 'commit-1',
        picks: [
          { path: 'x', name: 'bad name!', overwrite: false },
          { ...picks, overwrite: false },
        ],
      },
      null
    );
    expect(result.installed).toEqual(['customer-analysis']);
    expect(result.skipped).toEqual([{ name: 'bad name!', reason: 'invalid name' }]);
  });

  it('leaves the previous folder when a download fails mid-way', async () => {
    await mkdir(path.join(libraryDir, 'customer-analysis'), { recursive: true });
    await writeFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'existing');
    const broken = [...tree];
    broken[1] = { path: '.agents/skills/customer-analysis/SKILL.md', type: 'blob', sha: 'gone' };
    stubGitHub({ tree: broken, blobs });
    const result = await installGitHubSkills(
      libraryDir,
      {
        repo: 'o/r',
        ref: 'main',
        commit: 'commit-1',
        picks: [{ ...picks, overwrite: true }],
      },
      null
    );
    expect(result.installed).toEqual([]);
    expect(result.skipped[0]?.name).toBe('customer-analysis');
    expect(await readFile(path.join(libraryDir, 'customer-analysis', 'SKILL.md'), 'utf8')).toBe(
      'existing'
    );
  });
});

type ZipSpec = {
  name: string;
  data: Buffer | string;
  method?: number;
  flags?: number;
  attr?: number;
  compressed?: Buffer;
  uncompressedSize?: number;
  cdUncompressedSize?: number;
  localName?: string;
};

/** Unix external attributes. Shift stays unsigned: `<<` alone sets the sign bit. */
function unixAttr(mode: number): number {
  return (mode << 16) >>> 0;
}

/** A store (or deflate) zip built from the central directory. No zip package. */
function zipArchive(entries: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const stored = entry.compressed ?? data;
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const localSize = entry.uncompressedSize ?? data.length;
    const cdSize = entry.cdUncompressedSize ?? localSize;
    const compressedSize = stored.length;
    const crc = crc32(data);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const cdName = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(localSize, 22);
    local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(cdSize, 24);
    central.writeUInt16LE(cdName.length, 28);
    central.writeUInt32LE(entry.attr ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    const localFull = Buffer.concat([local, localName, stored]);
    locals.push(localFull);
    centrals.push(Buffer.concat([central, cdName]));
    offset += localFull.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const importCall = (
  libraryDir: string,
  sourcePath: string,
  options: { overwrite?: boolean; apply?: boolean; cwd?: string | null } = {}
) =>
  importLocalSkills(libraryDir, {
    sourcePath,
    cwd: options.cwd ?? null,
    overwrite: options.overwrite ?? false,
    apply: options.apply ?? true,
  });

async function scratchNames(libraryDir: string): Promise<string[]> {
  const dir = path.join(libraryDir, '.emdash', 'skill-update');
  return (await readdir(dir).catch(() => [] as string[])).filter((name) =>
    name.startsWith('import-')
  );
}

describe('importLocalSkills', () => {
  let home: string;
  let libraryDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'skill-import-'));
    libraryDir = path.join(home, '.agentskills');
    await mkdir(libraryDir);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('replaces an existing skill folder and drops files the new tree lacks', async () => {
    const skillDir = path.join(libraryDir, 'review-pr');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), 'old');
    await writeFile(path.join(skillDir, 'old-only.md'), 'gone');
    const source = path.join(home, 'incoming', 'review-pr');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), 'new');
    await writeFile(path.join(source, 'run.sh'), 'echo hi\n');
    await chmod(path.join(source, 'run.sh'), 0o755);
    const outside = path.join(home, 'sentinel.txt');
    await writeFile(outside, 'sentinel');

    const result = await importCall(libraryDir, source, { overwrite: true });

    expect(result).toMatchObject({ imported: [], replaced: ['review-pr'], pendingReplace: [] });
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('new');
    await expect(lstat(path.join(skillDir, 'old-only.md'))).rejects.toThrow();
    expect((await lstat(path.join(skillDir, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(await readFile(outside, 'utf8')).toBe('sentinel');
    expect(await scratchNames(libraryDir)).toEqual([]);
  });

  it('plans a second import, then replaces only when overwrite is set', async () => {
    const skillDir = path.join(libraryDir, 'review-pr');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), 'new');
    const source = path.join(home, 'incoming', 'review-pr');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), 'new');

    const plan = await importCall(libraryDir, source, { apply: false });
    expect(plan).toMatchObject({ imported: [], replaced: [], pendingReplace: ['review-pr'] });
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('new');

    await writeFile(path.join(source, 'SKILL.md'), 'newer');
    await importCall(libraryDir, source, { overwrite: false, apply: true });
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('new');

    const replaced = await importCall(libraryDir, source, { overwrite: true, apply: true });
    expect(replaced.replaced).toEqual(['review-pr']);
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('newer');
    expect(await scratchNames(libraryDir)).toEqual([]);
  });

  it('refuses a zip slip from the central directory and leaves the library alone', async () => {
    const skillDir = path.join(libraryDir, 'review-pr');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), 'old');
    const sentinel = path.join(home, 'sentinel.txt');
    await writeFile(sentinel, 'sentinel');
    const zipPath = path.join(home, 'slip.zip');
    await writeFile(
      zipPath,
      zipArchive([
        { name: 'review-pr/SKILL.md', data: 'new' },
        { name: '../../outside.md', data: 'pwned' },
      ])
    );

    await expect(importCall(libraryDir, zipPath, { overwrite: true })).rejects.toThrow(/outside/);
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('old');
    expect(await readFile(sentinel, 'utf8')).toBe('sentinel');
    await expect(lstat(path.join(home, 'outside.md'))).rejects.toThrow();
    await expect(lstat(path.join(libraryDir, 'outside.md'))).rejects.toThrow();
    expect(await scratchNames(libraryDir)).toEqual([]);
  });

  it('trusts the central-directory name when the local header disagrees', async () => {
    const sentinel = path.join(home, 'sentinel.txt');
    await writeFile(sentinel, 'sentinel');
    const zipPath = path.join(home, 'names.zip');
    await writeFile(
      zipPath,
      zipArchive([
        {
          name: 'review-pr/SKILL.md',
          localName: '../../outside.md',
          data: 'from-central',
        },
      ])
    );

    const result = await importCall(libraryDir, zipPath);
    expect(result.imported).toEqual(['review-pr']);
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe(
      'from-central'
    );
    await expect(lstat(path.join(home, 'outside.md'))).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe('sentinel');
  });

  it('rejects a symlink that leaves the source folder', async () => {
    const secret = path.join(home, 'secret.txt');
    await writeFile(secret, 'top secret');
    const source = path.join(home, 'incoming');
    await mkdir(path.join(source, 'review-pr'), { recursive: true });
    await writeFile(path.join(source, 'review-pr', 'SKILL.md'), 'new');
    await symlink(secret, path.join(source, 'review-pr', 'leak'));
    await mkdir(path.join(libraryDir, 'review-pr'));
    await writeFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'old');

    await expect(importCall(libraryDir, source, { overwrite: true })).rejects.toThrow(
      'Symlink review-pr/leak points outside the skill folder'
    );
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('old');
    await expect(lstat(path.join(libraryDir, 'review-pr', 'leak'))).rejects.toThrow();
    expect(await readFile(secret, 'utf8')).toBe('top secret');
    const libraryFiles = await readdir(libraryDir);
    expect(libraryFiles).not.toContain('secret.txt');
    expect(await scratchNames(libraryDir)).toEqual([]);
  });

  it('skips a symlink that stays inside and does not recreate it', async () => {
    const source = path.join(home, 'review-pr');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), 'body');
    await symlink('SKILL.md', path.join(source, 'link'));

    await importCall(libraryDir, source);
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('body');
    await expect(lstat(path.join(libraryDir, 'review-pr', 'link'))).rejects.toThrow();
  });

  it('rejects a fifo without reading it', async () => {
    const source = path.join(home, 'incoming');
    await mkdir(path.join(source, 'review-pr'), { recursive: true });
    await writeFile(path.join(source, 'review-pr', 'SKILL.md'), 'new');
    execFileSync('mkfifo', [path.join(source, 'review-pr', 'pipe')]);

    await expect(importCall(libraryDir, source)).rejects.toThrow('Unsupported file review-pr/pipe');
    await expect(lstat(path.join(libraryDir, 'review-pr'))).rejects.toThrow();
  });

  it('rejects a zip symlink that points outside and skips one that stays inside', async () => {
    const outside = path.join(home, 'escape.zip');
    await writeFile(
      outside,
      zipArchive([
        { name: 'review-pr/SKILL.md', data: 'new' },
        { name: 'review-pr/leak', data: '/tmp/secret.txt', attr: unixAttr(0o120777) },
      ])
    );
    await expect(importCall(libraryDir, outside)).rejects.toThrow(
      'Symlink review-pr/leak points outside the skill folder'
    );
    await expect(lstat(path.join(libraryDir, 'review-pr'))).rejects.toThrow();

    const inside = path.join(home, 'inside.zip');
    await writeFile(
      inside,
      zipArchive([
        { name: 'review-pr/SKILL.md', data: 'kept' },
        { name: 'review-pr/link', data: 'SKILL.md', attr: unixAttr(0o120777) },
      ])
    );
    await importCall(libraryDir, inside);
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('kept');
    await expect(lstat(path.join(libraryDir, 'review-pr', 'link'))).rejects.toThrow();
  });

  it('stops before extract when the central directory declares too many bytes', async () => {
    await mkdir(path.join(libraryDir, 'review-pr'));
    await writeFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'old');
    const zipPath = path.join(home, 'huge.zip');
    await writeFile(
      zipPath,
      zipArchive([
        {
          name: 'review-pr/SKILL.md',
          data: 'new',
          cdUncompressedSize: 8 * 1024 * 1024 + 1,
        },
      ])
    );
    await expect(importCall(libraryDir, zipPath, { overwrite: true })).rejects.toThrow(
      'Skill archive is too large'
    );
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('old');
    expect(await scratchNames(libraryDir)).toEqual([]);
  });

  it('stops a deflate stream once the uncompressed bytes pass 8 MiB', async () => {
    await mkdir(path.join(libraryDir, 'review-pr'));
    await writeFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'old');
    const raw = Buffer.alloc(8 * 1024 * 1024 + 64);
    const compressed = deflateRawSync(raw);
    const zipPath = path.join(home, 'bomb.zip');
    await writeFile(
      zipPath,
      zipArchive([
        { name: 'review-pr/SKILL.md', data: 'new' },
        {
          name: 'review-pr/bomb.bin',
          data: raw,
          method: 8,
          compressed,
          uncompressedSize: 32,
        },
      ])
    );
    await expect(importCall(libraryDir, zipPath, { overwrite: true })).rejects.toThrow(
      'Skill archive is too large'
    );
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('old');
    expect(await scratchNames(libraryDir)).toEqual([]);
  });

  it('rejects a zip larger than 8 MiB before reading it as an archive', async () => {
    const zipPath = path.join(home, 'big.zip');
    await writeFile(zipPath, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(importCall(libraryDir, zipPath)).rejects.toThrow('Skill archive is too large');
  });

  it('rejects encrypted, Zip64, and unknown methods', async () => {
    const cases = [
      zipArchive([{ name: 'review-pr/SKILL.md', data: 'x', flags: 1 }]),
      zipArchive([{ name: 'review-pr/SKILL.md', data: 'x', cdUncompressedSize: 0xffffffff }]),
      zipArchive([{ name: 'review-pr/SKILL.md', data: 'x', method: 1 }]),
    ];
    for (const [index, bytes] of cases.entries()) {
      const zipPath = path.join(home, `bad-${index}.zip`);
      await writeFile(zipPath, bytes);
      await expect(importCall(libraryDir, zipPath)).rejects.toThrow('Unsupported zip');
    }
    await expect(lstat(path.join(libraryDir, 'review-pr'))).rejects.toThrow();
  });

  it('rejects a zip fifo without writing the skill', async () => {
    const zipPath = path.join(home, 'fifo.zip');
    await writeFile(
      zipPath,
      zipArchive([
        { name: 'review-pr/SKILL.md', data: 'new' },
        { name: 'review-pr/pipe', data: 'x', attr: unixAttr(0o010644) },
      ])
    );
    await expect(importCall(libraryDir, zipPath)).rejects.toThrow(
      'Unsupported file review-pr/pipe'
    );
    await expect(lstat(path.join(libraryDir, 'review-pr'))).rejects.toThrow();
  });

  it('throws when there are more than 50 skills and writes none', async () => {
    await mkdir(path.join(libraryDir, 'keep'));
    await writeFile(path.join(libraryDir, 'keep', 'SKILL.md'), 'stay');
    const entries = Array.from({ length: 51 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, '0')}/SKILL.md`,
      data: '---\nname: \n---\nbody\n',
    }));
    const zipPath = path.join(home, 'many.zip');
    await writeFile(zipPath, zipArchive(entries));
    await expect(importCall(libraryDir, zipPath, { overwrite: true })).rejects.toThrow(
      'Too many skills'
    );
    expect(await readFile(path.join(libraryDir, 'keep', 'SKILL.md'), 'utf8')).toBe('stay');
    expect(await readdir(libraryDir)).toEqual(['keep']);
  });

  it('counts dropped junk toward the file limit and does not write it', async () => {
    const source = path.join(home, 'review-pr');
    await mkdir(path.join(source, '__MACOSX'), { recursive: true });
    await mkdir(path.join(source, '.git'), { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), 'body');
    await writeFile(path.join(source, '.DS_Store'), 'junk');
    await writeFile(path.join(source, '__MACOSX', '._SKILL.md'), 'junk');
    await writeFile(path.join(source, '.git', 'config'), 'junk');
    await importCall(libraryDir, source);
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('body');
    await expect(lstat(path.join(libraryDir, 'review-pr', '.DS_Store'))).rejects.toThrow();
    await expect(lstat(path.join(libraryDir, 'review-pr', '__MACOSX'))).rejects.toThrow();
    await expect(lstat(path.join(libraryDir, 'review-pr', '.git'))).rejects.toThrow();

    const crowded = path.join(home, 'crowded');
    await mkdir(path.join(crowded, '__MACOSX'), { recursive: true });
    await writeFile(path.join(crowded, 'SKILL.md'), 'body');
    for (let index = 0; index < 500; index += 1) {
      await writeFile(path.join(crowded, '__MACOSX', `f${index}`), 'x');
    }
    await expect(importCall(libraryDir, crowded, { overwrite: true })).rejects.toThrow(
      'Skill archive is too large'
    );
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('body');
  });

  it('names skills from frontmatter, folder, and zip file, and skips bad duplicates', async () => {
    const folder = path.join(home, 'v1.2_x');
    await mkdir(folder);
    await writeFile(path.join(folder, 'SKILL.md'), '---\nname: "   "\n---\nbody\n');
    expect((await importCall(libraryDir, folder)).imported).toEqual(['v1.2_x']);

    const named = path.join(home, 'ship.zip');
    await writeFile(
      named,
      zipArchive([{ name: 'SKILL.md', data: '---\nname: ship-note\n---\nnote\n' }])
    );
    expect((await importCall(libraryDir, named)).imported).toEqual(['ship-note']);

    const rooted = path.join(home, 'my-skill.zip');
    await writeFile(rooted, zipArchive([{ name: 'SKILL.md', data: '---\n---\nroot\n' }]));
    expect((await importCall(libraryDir, rooted)).imported).toEqual(['my-skill']);

    const mixed = path.join(home, 'mixed.zip');
    await writeFile(
      mixed,
      zipArchive([
        { name: 'a/SKILL.md', data: '---\nname: same\n---\nfirst\n' },
        { name: 'b/SKILL.md', data: '---\nname: same\n---\nsecond\n' },
        { name: 'c/SKILL.md', data: '---\nname: "../x"\n---\nnope\n' },
        { name: 'ok-name/SKILL.md', data: '---\nname: "bad name"\n---\nnope\n' },
        { name: 'good/SKILL.md', data: '---\ndescription: ok\n---\nyes\n' },
      ])
    );
    const result = await importCall(libraryDir, mixed);
    expect(result.imported).toEqual(['same', 'good']);
    expect(result.skipped).toEqual([
      { name: 'same', reason: 'duplicate name' },
      { name: '../x', reason: 'invalid name' },
      { name: 'bad name', reason: 'invalid name' },
    ]);
    expect(await readFile(path.join(libraryDir, 'same', 'SKILL.md'), 'utf8')).toContain('first');
    await expect(lstat(path.join(libraryDir, 'ok-name'))).rejects.toThrow();
  });

  it('resolves a relative path from cwd and does not expand a tilde', async () => {
    const source = path.join(home, 'review-pr');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), 'relative');
    const result = await importCall(libraryDir, 'review-pr', { cwd: home });
    expect(result.imported).toEqual(['review-pr']);
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('relative');

    await expect(importCall(libraryDir, '~/skills/missing')).rejects.toThrow(
      'Name an absolute path'
    );
    await expect(importCall(libraryDir, '~/skills/missing', { cwd: home })).rejects.toThrow(
      'Pick a skill folder or a .zip'
    );
  });

  it('rejects a source inside the library and a path that is not a skill archive', async () => {
    await expect(importCall(libraryDir, libraryDir)).rejects.toThrow(
      'Source is inside the skill library'
    );
    const note = path.join(home, 'note.txt');
    await writeFile(note, 'nope');
    await expect(importCall(libraryDir, note)).rejects.toThrow('Pick a skill folder or a .zip');
    await expect(importCall(libraryDir, path.join(home, 'missing'))).rejects.toThrow(
      'Pick a skill folder or a .zip'
    );
    const empty = path.join(home, 'empty.zip');
    await writeFile(empty, zipArchive([{ name: 'README.md', data: 'hi' }]));
    await expect(importCall(libraryDir, empty)).rejects.toThrow('No SKILL.md found');
  });

  it('leaves an existing skill untouched when overwrite is false', async () => {
    await mkdir(path.join(libraryDir, 'review-pr'));
    await writeFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'old');
    const source = path.join(home, 'review-pr');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), 'new');
    const result = await importCall(libraryDir, source, { overwrite: false, apply: true });
    expect(result).toMatchObject({
      imported: [],
      replaced: [],
      pendingReplace: ['review-pr'],
    });
    expect(await readFile(path.join(libraryDir, 'review-pr', 'SKILL.md'), 'utf8')).toBe('old');
  });
});
