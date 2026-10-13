import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSkillUpdates,
  gitTreeId,
  isSafeSkillName,
  parseGitHubSkillUrl,
  remoteFileTarget,
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
  let tree: { path: string; type: string; sha?: string }[];
  let truncated: boolean;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'skill-sources-'));
    libraryDir = path.join(home, '.agentskills');
    await mkdir(path.join(libraryDir, 'demo'), { recursive: true });
    await writeFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'old');
    truncated = false;
    tree = [
      { path: 'skills', type: 'tree', sha: 'tree-skills' },
      { path: 'skills/demo', type: 'tree', sha: 'tree-demo' },
      { path: 'skills/demo/SKILL.md', type: 'blob' },
      { path: 'skills/demo/docs/guide.md', type: 'blob' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/repos/o/r/commits/main') {
          return Response.json({ sha: 'commit-1', commit: { tree: { sha: 'root' } } });
        }
        if (url.pathname.startsWith('/repos/o/r/commits/')) {
          return new Response('{}', { status: 422 });
        }
        if (url.pathname === '/repos/o/r/git/trees/root') {
          return Response.json({ tree, truncated });
        }
        if (url.hostname === 'raw.githubusercontent.com') {
          return new Response(`new ${url.pathname}`);
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
    expect(await readFile(path.join(libraryDir, 'demo', 'SKILL.md'), 'utf8')).toBe(
      'new /o/r/commit-1/skills/demo/SKILL.md'
    );
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
    tree.push({ path: 'skills/demo/../../evil.md', type: 'blob' });
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
});
