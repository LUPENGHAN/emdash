import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSkillUpdates,
  gitTreeId,
  installGitHubSkills,
  isSafeSkillName,
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
    expect(result).toEqual({
      updated: true,
      dirty: false,
      files: ['SKILL.md', 'docs/guide.md'],
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
