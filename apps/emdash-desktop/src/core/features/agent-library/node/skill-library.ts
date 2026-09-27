import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentSkillFound } from '../api';

const execFileAsync = promisify(execFile);

/** The library folder, shared with Emdash's skill catalog (install/create). */
export const SKILL_LIBRARY_DIRNAME = '.agentskills';
/**
 * Where a workspace's skills go. Claude Code only reads `.claude/skills`; Codex and Pi
 * read `.agents/skills`; OpenCode, Oh My Pi and Cursor read both (one name, one skill).
 */
export const WORKSPACE_SKILLS_DIRS = [
  path.join('.claude', 'skills'),
  path.join('.agents', 'skills'),
];
const EXCLUDE_BEGIN = '# >>> emdash skills (managed)';
const EXCLUDE_END = '# <<< emdash skills';

/** The agents' own skill folders (relative to home) that the library can import from. */
export const AGENT_SKILL_DIRS: readonly { agent: string; dir: string }[] = [
  { agent: 'claude', dir: '.claude/skills' },
  { agent: 'codex', dir: '.codex/skills' },
  { agent: 'opencode', dir: '.config/opencode/skills' },
  { agent: 'opencode', dir: '.config/opencode/skill' },
  { agent: 'pi', dir: '.pi/agent/skills' },
  { agent: 'oh-my-pi', dir: '.omp/agent/skills' },
  { agent: 'cursor', dir: '.cursor/skills' },
  { agent: 'shared', dir: '.agents/skills' },
];

export type LibrarySkill = { name: string; description: string };

/** Skills in the library folder: sub-folders with a SKILL.md (dot-folders are metadata). */
export async function listLibrarySkills(libraryDir: string): Promise<LibrarySkill[]> {
  const entries = await readdir(libraryDir).catch(() => [] as string[]);
  const skills: LibrarySkill[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue;
    const content = await readFile(path.join(libraryDir, name, 'SKILL.md'), 'utf8').catch(
      () => null
    );
    if (content !== null)
      skills.push({ name, description: frontmatterField(content, 'description') });
  }
  return skills;
}

/**
 * Makes each of the workspace's skill folders hold exactly `names` as symlinks into the
 * library, leaving the repository's own skills alone, and keeps the links out of git.
 */
export async function syncWorkspaceSkills(input: {
  workspacePath: string;
  libraryDir: string;
  names: readonly string[];
}): Promise<{ linked: string[]; shadowed: string[] }> {
  const libraryRoot = path.resolve(input.libraryDir);
  const wanted = new Set(input.names);
  const linked = new Set<string>();
  const shadowed = new Set<string>();
  const excluded: string[] = [];

  for (const relativeDir of WORKSPACE_SKILLS_DIRS) {
    const dir = path.join(input.workspacePath, relativeDir);
    // Drop our links for skills the workspace should no longer have.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const target = await managedLinkTarget(path.join(dir, name), libraryRoot);
      if (target !== null && !wanted.has(name)) await unlink(path.join(dir, name));
    }
    if (wanted.size > 0) await mkdir(dir, { recursive: true });
    for (const name of wanted) {
      const link = path.join(dir, name);
      const source = path.join(libraryRoot, name);
      const target = await managedLinkTarget(link, libraryRoot);
      if (target !== source) {
        if (target !== null) await unlink(link);
        else if (await exists(link)) {
          // The repository ships its own skill under this name; it wins.
          shadowed.add(name);
          continue;
        }
        await symlink(source, link, 'dir');
      }
      linked.add(name);
      excluded.push(`/${relativeDir}/${name}`);
    }
  }
  await writeExcludeBlock(input.workspacePath, excluded);
  return { linked: [...linked], shadowed: [...shadowed] };
}

/** Skills in the agents' own folders, merged by name. */
export async function scanAgentSkills(
  home: string,
  libraryNames: ReadonlySet<string>
): Promise<(AgentSkillFound & { sources: string[] })[]> {
  const byName = new Map<string, AgentSkillFound & { sources: string[] }>();
  for (const { agent, dir } of AGENT_SKILL_DIRS) {
    const root = path.join(home, dir);
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (name.startsWith('.')) continue;
      const entry = path.join(root, name);
      const content = await readFile(path.join(entry, 'SKILL.md'), 'utf8').catch(() => null);
      if (content === null) continue;
      const found = byName.get(name) ?? {
        name,
        description: frontmatterField(content, 'description'),
        agents: [],
        inLibrary: libraryNames.has(name),
        sources: [],
      };
      if (!found.agents.includes(agent)) found.agents.push(agent);
      found.sources.push(entry);
      byName.set(name, found);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Copies found skills into the library (symlinks followed); names already there stay. */
export async function importSkills(
  found: readonly { name: string; sources: string[] }[],
  libraryDir: string
): Promise<{ imported: string[]; alreadyInLibrary: string[] }> {
  await mkdir(libraryDir, { recursive: true });
  const imported: string[] = [];
  const alreadyInLibrary: string[] = [];
  for (const skill of found) {
    const destination = path.join(libraryDir, skill.name);
    if (await exists(destination)) {
      alreadyInLibrary.push(skill.name);
      continue;
    }
    const source = await realpath(skill.sources[0]!);
    await cp(source, destination, { recursive: true, dereference: true });
    imported.push(skill.name);
  }
  return { imported, alreadyInLibrary };
}

/**
 * Moves the agents' own copies of library skills (links or folders) into a timestamped
 * backup, so only Emdash hands them out. Nothing is deleted.
 */
export async function takeOverSkills(
  found: readonly { name: string; sources: string[] }[],
  libraryNames: ReadonlySet<string>,
  backupRoot: string,
  home: string,
  now = new Date()
): Promise<{ moved: number; backupDir: string | null }> {
  const backupDir = path.join(backupRoot, now.toISOString().replace(/[:.]/g, '-'));
  let moved = 0;
  for (const skill of found) {
    if (!libraryNames.has(skill.name)) continue;
    for (const source of skill.sources) {
      const relative = path.relative(home, source);
      const destination = path.join(backupDir, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      moved += 1;
    }
  }
  return { moved, backupDir: moved > 0 ? backupDir : null };
}

async function managedLinkTarget(link: string, libraryRoot: string): Promise<string | null> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) return null;
    const target = path.resolve(path.dirname(link), await readlink(link));
    return target.startsWith(`${libraryRoot}${path.sep}`) ? target : null;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** Lists our links in the repository's local exclude file (shared by its worktrees). */
async function writeExcludeBlock(workspacePath: string, entries: readonly string[]): Promise<void> {
  let excludeFile: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: workspacePath,
    });
    excludeFile = path.resolve(workspacePath, stdout.trim());
  } catch {
    return; // Not a git repository: nothing to keep out.
  }
  const current = await readFile(excludeFile, 'utf8').catch(() => '');
  const start = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END);
  const kept =
    start !== -1 && end > start
      ? current.slice(0, start) + current.slice(end + EXCLUDE_END.length).replace(/^\n/, '')
      : current;
  const block =
    entries.length > 0
      ? [EXCLUDE_BEGIN, ...[...entries].sort((a, b) => a.localeCompare(b)), EXCLUDE_END].join(
          '\n'
        ) + '\n'
      : '';
  const next = kept && !kept.endsWith('\n') && block ? `${kept}\n${block}` : `${kept}${block}`;
  if (next === current) return;
  await mkdir(path.dirname(excludeFile), { recursive: true });
  await writeFile(excludeFile, next);
}

function frontmatterField(markdown: string, field: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return '';
  const line = match[1]!.split(/\r?\n/).find((l) => l.startsWith(`${field}:`));
  return line
    ? line
        .slice(field.length + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    : '';
}
