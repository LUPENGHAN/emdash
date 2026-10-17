import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchMcpServer } from '../api';
import { pruneCursorPluginDirs, writeCursorPluginDir } from './cursor-plugin';

describe('cursor plugin dir', () => {
  let root: string;
  const stdio: LaunchMcpServer = {
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['serve'],
    env: { KEY: 'v' },
  };
  const http: LaunchMcpServer = {
    name: 'web',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer k' },
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cursor-plugins-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes plugin.json and mcp.json for stdio and http servers', async () => {
    const dir = await writeCursorPluginDir(root, 'conv-1', [stdio, http]);
    expect(dir).toBe(path.join(root, 'conv-1'));
    expect(
      JSON.parse(await readFile(path.join(dir, '.cursor-plugin', 'plugin.json'), 'utf8'))
    ).toEqual({
      name: 'emdash-library',
      version: '1.0.0',
      description: 'MCP servers from the Emdash library',
    });
    expect(JSON.parse(await readFile(path.join(dir, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        files: { command: 'npx', args: ['serve'], env: { KEY: 'v' } },
        web: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer k' } },
      },
    });
    // The folder can carry secrets, so only this user may read it.
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dir, 'mcp.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('rewrites the whole folder on every launch', async () => {
    const dir = await writeCursorPluginDir(root, 'conv-1', [stdio]);
    await writeCursorPluginDir(root, 'conv-1', [http]);
    expect(JSON.parse(await readFile(path.join(dir, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        web: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer k' } },
      },
    });
  });

  it('refuses a conversation id that could escape the root', async () => {
    await expect(writeCursorPluginDir(root, '../x', [stdio])).rejects.toThrow();
    await expect(writeCursorPluginDir(root, 'a/b', [stdio])).rejects.toThrow();
    await expect(writeCursorPluginDir(root, 'a b', [stdio])).rejects.toThrow();
  });

  it('prunes folders not written for two weeks and keeps fresh ones', async () => {
    await writeCursorPluginDir(root, 'old', [stdio]);
    await writeCursorPluginDir(root, 'fresh', [stdio]);
    await utimes(path.join(root, 'old'), new Date(0), new Date(0));
    await pruneCursorPluginDirs(root);
    await expect(stat(path.join(root, 'old'))).rejects.toThrow();
    expect((await stat(path.join(root, 'fresh'))).isDirectory()).toBe(true);
  });
});
