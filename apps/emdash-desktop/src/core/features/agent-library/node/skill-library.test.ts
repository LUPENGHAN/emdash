import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importSkills,
  listLibrarySkills,
  scanAgentSkills,
  syncWorkspaceSkills,
  takeOverSkills,
} from './skill-library';

async function skill(dir: string, name: string, description = `${name} does things`) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`
  );
}

describe('skill library', () => {
  let root: string;
  let home: string;
  let library: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'emdash-skills-'));
    home = path.join(root, 'home');
    library = path.join(home, '.agentskills');
    workspace = path.join(root, 'repo');
    await mkdir(workspace, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    await skill(library, 'grill-me');
    await skill(library, 'archify');
    await mkdir(path.join(library, '.emdash'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists library skills with their descriptions, skipping metadata', async () => {
    expect(await listLibrarySkills(library)).toEqual([
      { name: 'archify', description: 'archify does things' },
      { name: 'grill-me', description: 'grill-me does things' },
    ]);
  });

  it('links the wanted skills into .claude/skills and .agents/skills, git-excluded, pruning stale links', async () => {
    const agentsDir = path.join(workspace, '.agents', 'skills');
    const claudeDir = path.join(workspace, '.claude', 'skills');
    // The repository's own skill with a library name wins over the library there.
    await skill(agentsDir, 'archify', 'repo version');

    const first = await syncWorkspaceSkills({
      workspacePath: workspace,
      libraryDir: library,
      names: ['grill-me', 'archify'],
    });
    expect(first).toEqual({ linked: ['grill-me', 'archify'], shadowed: ['archify'] });
    for (const dir of [agentsDir, claudeDir]) {
      expect(await readlink(path.join(dir, 'grill-me'))).toBe(path.join(library, 'grill-me'));
    }
    expect(await readlink(path.join(claudeDir, 'archify'))).toBe(path.join(library, 'archify'));
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: workspace,
    }).toString();
    expect(status).not.toContain('grill-me');
    expect(status).not.toContain('.claude');
    expect(status).toContain('.agents/skills/archify/SKILL.md');

    await syncWorkspaceSkills({ workspacePath: workspace, libraryDir: library, names: [] });
    for (const dir of [agentsDir, claudeDir]) {
      await expect(lstat(path.join(dir, 'grill-me'))).rejects.toThrow();
    }
    expect((await lstat(path.join(agentsDir, 'archify'))).isDirectory()).toBe(true);
    const exclude = await readFile(path.join(workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('emdash skills');
  });

  it('finds, imports (through links) and takes over the agents’ own skills', async () => {
    const shared = path.join(root, 'cc-switch', 'natural-writing');
    await skill(path.dirname(shared), 'natural-writing');
    await writeFile(path.join(shared, 'rules.md'), 'extra file');
    await mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
    await symlink(shared, path.join(home, '.claude', 'skills', 'natural-writing'));
    await skill(path.join(home, '.codex', 'skills'), 'natural-writing');
    await skill(path.join(home, '.codex', 'skills'), 'grill-me');

    const libraryNames = new Set((await listLibrarySkills(library)).map((s) => s.name));
    const found = await scanAgentSkills(home, libraryNames);
    expect(found.map((f) => [f.name, f.agents, f.inLibrary])).toEqual([
      ['grill-me', ['codex'], true],
      ['natural-writing', ['claude', 'codex'], false],
    ]);

    expect(await importSkills(found, library)).toEqual({
      imported: ['natural-writing'],
      alreadyInLibrary: ['grill-me'],
    });
    expect(await readFile(path.join(library, 'natural-writing', 'rules.md'), 'utf8')).toBe(
      'extra file'
    );
    expect((await lstat(path.join(library, 'natural-writing'))).isSymbolicLink()).toBe(false);

    const all = new Set((await listLibrarySkills(library)).map((s) => s.name));
    const result = await takeOverSkills(
      found,
      all,
      path.join(library, '.emdash', 'takeover-backup'),
      home,
      new Date(0)
    );
    expect(result.moved).toBe(3);
    await expect(lstat(path.join(home, '.claude', 'skills', 'natural-writing'))).rejects.toThrow();
    const backedUpLink = path.join(result.backupDir!, '.claude', 'skills', 'natural-writing');
    expect((await lstat(backedUpLink)).isSymbolicLink()).toBe(true);
    // The link's own target is untouched.
    expect(await readFile(path.join(shared, 'rules.md'), 'utf8')).toBe('extra file');
  });
});
