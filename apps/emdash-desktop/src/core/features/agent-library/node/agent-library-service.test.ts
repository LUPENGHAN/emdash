import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_LIBRARY_SETTINGS, type AgentLibrarySettings } from '../api';
import { createAgentLibraryService } from './agent-library-service';

describe('createAgentLibraryService', () => {
  let root: string;
  let settings: AgentLibrarySettings;
  let listeners: Set<() => void>;
  const workspaces: { projectId: string; path: string }[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'emdash-library-'));
    settings = { ...DEFAULT_AGENT_LIBRARY_SETTINGS };
    listeners = new Set();
    workspaces.length = 0;
    for (const name of ['grill-me', 'archify']) {
      await mkdir(path.join(root, '.agentskills', name), { recursive: true });
      await writeFile(
        path.join(root, '.agentskills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: about ${name}\n---\n`
      );
    }
    for (const [projectId, dir] of [
      ['p1', 'repo1'],
      ['p2', 'repo2'],
    ] as const) {
      const workspace = path.join(root, dir);
      await mkdir(workspace);
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      workspaces.push({ projectId, path: workspace });
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const service = () =>
    createAgentLibraryService({
      home: root,
      getSettings: async () => settings,
      onSettingsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listLocalWorkspaces: async () => workspaces,
      refreshSkillCatalog: vi.fn(async () => {}),
      getGitHubToken: async () => null,
    });
  const linked = async (workspace: string) =>
    (await readdir(path.join(workspace, '.claude', 'skills')).catch(() => [])).sort((a, b) =>
      a.localeCompare(b)
    );

  it('gives each project its skills and MCP servers, following scope changes', async () => {
    settings = {
      skillProjects: { archify: ['p2'] },
      mcpServers: [
        { name: 'everywhere', transport: 'http', url: 'http://x', enabled: true },
        { name: 'p1-only', transport: 'stdio', command: 'run', enabled: true, projects: ['p1'] },
        { name: 'off', transport: 'stdio', command: 'x', enabled: false },
      ],
    };
    const library = service();
    await library.prepareWorkspace(workspaces[0]!);
    expect(await linked(workspaces[0]!.path)).toEqual(['grill-me']);
    expect(
      (await lstat(path.join(workspaces[0]!.path, '.agents/skills/grill-me'))).isSymbolicLink()
    ).toBe(true);

    expect(await library.effectiveFor('p2')).toEqual({
      skills: [
        { name: 'archify', description: 'about archify' },
        { name: 'grill-me', description: 'about grill-me' },
      ],
      mcpServers: ['everywhere'],
    });
    expect((await library.launchMcpServers('p1')).map((server) => server.name)).toEqual([
      'everywhere',
      'p1-only',
    ]);

    // Making archify global reaches every workspace without a relaunch.
    settings = { ...settings, skillProjects: {} };
    for (const listener of listeners) listener();
    await vi.waitFor(async () =>
      expect(await linked(workspaces[0]!.path)).toEqual(['archify', 'grill-me'])
    );
    expect(await linked(workspaces[1]!.path)).toEqual(['archify', 'grill-me']);
    // Symlinks appear before the background sync finishes updating Git excludes.
    // Drain the per-workspace queues before the fixture directory is removed.
    await library.resyncAll();
    library.dispose();
  });

  it('refreshes the catalog after an import replaces the skill body', async () => {
    const refreshSkillCatalog = vi.fn(async () => {});
    const warn = vi.fn();
    const library = createAgentLibraryService({
      home: root,
      getSettings: async () => settings,
      onSettingsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listLocalWorkspaces: async () => workspaces,
      refreshSkillCatalog,
      getGitHubToken: async () => null,
      warn,
    });
    const installed = path.join(root, '.agentskills', 'review-pr');
    await mkdir(installed);
    await writeFile(
      path.join(installed, 'SKILL.md'),
      '---\nname: review-pr\ndescription: before\n---\nold body\n'
    );
    const source = path.join(root, 'incoming', 'review-pr');
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: review-pr\ndescription: after import\n---\nnew body\n'
    );

    const result = await library.importLocalSkills({
      sourcePath: source,
      cwd: null,
      overwrite: true,
      apply: true,
    });
    expect(result.replaced).toEqual(['review-pr']);
    expect(refreshSkillCatalog).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(await readFile(path.join(installed, 'SKILL.md'), 'utf8')).toContain('new body');
    expect(
      (await library.effectiveFor(null)).skills.find((skill) => skill.name === 'review-pr')
        ?.description
    ).toBe('after import');

    const plan = await library.importLocalSkills({
      sourcePath: source,
      cwd: null,
      overwrite: false,
      apply: false,
    });
    expect(plan.pendingReplace).toEqual(['review-pr']);
    expect(refreshSkillCatalog).toHaveBeenCalledTimes(1);
    library.dispose();
  });

  it('keeps the imported files when the catalog refresh fails', async () => {
    const refreshSkillCatalog = vi.fn(async () => {
      throw new Error('catalog down');
    });
    const warn = vi.fn();
    const library = createAgentLibraryService({
      home: root,
      getSettings: async () => settings,
      onSettingsChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listLocalWorkspaces: async () => workspaces,
      refreshSkillCatalog,
      getGitHubToken: async () => null,
      warn,
    });
    const source = path.join(root, 'incoming', 'ship-note');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: ship-note\n---\nnote\n');
    await expect(
      library.importLocalSkills({
        sourcePath: source,
        cwd: null,
        overwrite: false,
        apply: true,
      })
    ).resolves.toMatchObject({ imported: ['ship-note'], replaced: [] });
    expect(warn).not.toHaveBeenCalled();
    expect(
      await readFile(path.join(root, '.agentskills', 'ship-note', 'SKILL.md'), 'utf8')
    ).toContain('note');
    library.dispose();
  });
});
