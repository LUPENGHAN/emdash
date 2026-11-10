import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchMcpServer } from '../api';
import { OMP_MCP_CONFIG_RELATIVE_PATH, writeOmpMcpConfig } from './omp-mcp-config';

const servers: LaunchMcpServer[] = [
  { name: 'emdash', transport: 'http', url: 'http://127.0.0.1:47821/mcp/c/s' },
  {
    name: 'github tools',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/mcp'],
    env: { GITHUB_TOKEN: 'secret' },
  },
  {
    name: 'web',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret' },
  },
];

describe('writeOmpMcpConfig', () => {
  let root: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'emdash-omp-mcp-'));
    workspace = path.join(root, 'repo');
    await mkdir(workspace, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const configPath = () => path.join(workspace, OMP_MCP_CONFIG_RELATIVE_PATH);

  it('writes the Emdash server as an env placeholder and keeps the other transports', async () => {
    expect(await writeOmpMcpConfig(workspace, servers)).toEqual({ status: 'written' });

    const config = JSON.parse(await readFile(configPath(), 'utf8'));
    expect(config.mcpServers.emdash).toEqual({ type: 'http', url: '${EMDASH_MCP_URL}' });
    expect(config.mcpServers['github tools']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/mcp'],
      env: { GITHUB_TOKEN: 'secret' },
    });
    expect(config.mcpServers.web).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
    if (process.platform !== 'win32') {
      expect((await lstat(configPath())).mode & 0o777).toBe(0o600);
    }
  });

  it('merges into a user config and lets Emdash win for its own server', async () => {
    const userConfig = {
      $schema: 'https://example.com/mcp-schema.json',
      disabledServers: ['unused'],
      mcpServers: {
        mine: { type: 'stdio', command: 'my-server' },
        emdash: { type: 'http', url: 'http://stale.example/mcp' },
      },
    };
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), `${JSON.stringify(userConfig)}\n`);

    expect(await writeOmpMcpConfig(workspace, servers)).toEqual({ status: 'written' });

    const config = JSON.parse(await readFile(configPath(), 'utf8'));
    expect(config.$schema).toBe(userConfig.$schema);
    expect(config.disabledServers).toEqual(['unused']);
    expect(config.mcpServers.mine).toEqual(userConfig.mcpServers.mine);
    expect(config.mcpServers.emdash).toEqual({ type: 'http', url: '${EMDASH_MCP_URL}' });
    expect(config.mcpServers['github tools'].command).toBe('npx');
  });

  it('does not rewrite identical content', async () => {
    await writeOmpMcpConfig(workspace, servers);
    const before = await lstat(configPath());

    expect(await writeOmpMcpConfig(workspace, servers)).toEqual({ status: 'unchanged' });
    if (process.platform !== 'win32') {
      expect((await lstat(configPath())).ino).toBe(before.ino);
    }
  });

  it('leaves a tracked config alone', async () => {
    await writeOmpMcpConfig(workspace, servers);
    const before = await readFile(configPath(), 'utf8');
    execFileSync('git', ['add', OMP_MCP_CONFIG_RELATIVE_PATH], { cwd: workspace });

    expect(
      await writeOmpMcpConfig(workspace, [{ name: 'other', transport: 'stdio', command: 'x' }])
    ).toMatchObject({ status: 'skipped' });
    expect(await readFile(configPath(), 'utf8')).toBe(before);
  });

  it('does not overwrite invalid JSON or a non-object mcpServers value', async () => {
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), '{');
    expect(await writeOmpMcpConfig(workspace, servers)).toMatchObject({ status: 'skipped' });
    expect(await readFile(configPath(), 'utf8')).toBe('{');

    await writeFile(configPath(), '{"mcpServers":[]}');
    expect(await writeOmpMcpConfig(workspace, servers)).toMatchObject({ status: 'skipped' });
    expect(await readFile(configPath(), 'utf8')).toBe('{"mcpServers":[]}');
  });

  it('does not follow a symlink', async () => {
    await mkdir(path.dirname(configPath()), { recursive: true });
    const target = path.join(path.dirname(configPath()), 'target.json');
    await writeFile(target, '{"mcpServers":{}}\n');
    await symlink(target, configPath());

    expect(await writeOmpMcpConfig(workspace, servers)).toMatchObject({ status: 'skipped' });
    expect(await readFile(target, 'utf8')).toBe('{"mcpServers":{}}\n');
  });

  it('does not write through a symlinked config directory', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(workspace, '.omp'));

    expect(await writeOmpMcpConfig(workspace, servers)).toMatchObject({ status: 'skipped' });
    await expect(lstat(path.join(outside, 'mcp.json'))).rejects.toThrow();
  });

  it('does nothing without servers', async () => {
    expect(await writeOmpMcpConfig(workspace, [])).toEqual({ status: 'unchanged' });
    await expect(lstat(configPath())).rejects.toThrow();
  });
});
