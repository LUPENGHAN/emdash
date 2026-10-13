import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaunchMcpServer } from '../api';
import { checkMcpHealth, classifyMcpServer, splitPackageSpec } from './mcp-status';

function server(
  partial: Partial<LaunchMcpServer> & Pick<LaunchMcpServer, 'name'>
): LaunchMcpServer {
  return { transport: 'stdio', ...partial };
}

describe('classifyMcpServer', () => {
  it('reads an npx package and a pinned version', () => {
    expect(
      classifyMcpServer(
        server({
          name: 'github',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github@1.2.3'],
        })
      )
    ).toEqual({ kind: 'npm', packageName: '@modelcontextprotocol/server-github@1.2.3' });
  });

  it('treats an http url as remote', () => {
    expect(
      classifyMcpServer(
        server({ name: 'supabase', transport: 'http', url: 'https://mcp.supabase.com/mcp' })
      )
    ).toEqual({
      kind: 'http',
      packageName: null,
    });
  });
});

describe('splitPackageSpec', () => {
  it('pins only exact versions', () => {
    expect(splitPackageSpec('npm', '@scope/pkg@1.2.3')).toEqual({
      name: '@scope/pkg',
      version: '1.2.3',
    });
    expect(splitPackageSpec('npm', '@scope/pkg')).toEqual({ name: '@scope/pkg', version: null });
    expect(splitPackageSpec('npm', 'pkg@latest')).toEqual({ name: 'pkg', version: null });
    expect(splitPackageSpec('npm', 'pkg@^1')).toEqual({ name: 'pkg', version: null });
    expect(splitPackageSpec('pypi', 'mcp-server-git==1.2.3')).toEqual({
      name: 'mcp-server-git',
      version: '1.2.3',
    });
    expect(splitPackageSpec('pypi', 'mcp-server-git>=1')).toEqual({
      name: 'mcp-server-git',
      version: null,
    });
  });
});

describe('checkMcpHealth over stdio', () => {
  let dir: string;
  let script: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-status-'));
    script = path.join(dir, 'fake-mcp.js');
    await writeFile(
      script,
      `
const readline = require('node:readline');
let initialized = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
  } else if (message.method === 'notifications/initialized') {
    initialized = true;
  } else if (message.method === 'tools/list') {
    send(initialized
      ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'not initialized' } });
  }
});
`
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('initializes with newline-delimited JSON and counts the tools', async () => {
    expect(
      await checkMcpHealth(server({ name: 'fake', command: process.execPath, args: [script] }))
    ).toEqual({ ok: true, tools: 2, error: null });
  });

  it('reports a process that exits without answering', async () => {
    const result = await checkMcpHealth(
      server({ name: 'broken', command: process.execPath, args: ['-e', 'process.exit(3)'] })
    );
    expect(result).toEqual({ ok: false, tools: null, error: 'Exited 3' });
  });
});
