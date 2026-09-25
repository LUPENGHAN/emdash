import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeProjectDirName,
  listExternalSessions,
  type ExternalSessionEnv,
  type ExternalSessionReaders,
} from './external-sessions';

vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

const noOpenCode: ExternalSessionReaders = { opencode: () => [] };

function bySessionId<T extends { sessionId: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

describe('listExternalSessions', () => {
  let home: string;
  let project: string;
  let env: ExternalSessionEnv;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'emdash-sessions-')));
    project = path.join(home, 'code', 'my.app');
    await mkdir(project, { recursive: true });
    env = { home, env: {} };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeClaude(sessionId: string, cwd: string, ...records: unknown[]) {
    const dir = path.join(home, '.claude', 'projects', claudeProjectDirName(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${sessionId}.jsonl`), jsonl(...records));
  }

  async function writeCodex(name: string, ...records: unknown[]) {
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '25');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), jsonl(...records));
  }

  it('encodes Claude project directories like the CLI does', () => {
    expect(claudeProjectDirName('/Users/me/app/.claude/worktrees/x')).toBe(
      '-Users-me-app--claude-worktrees-x'
    );
  });

  it('finds Claude sessions, skipping noise and preferring the custom title', async () => {
    await writeClaude(
      'aaa',
      project,
      { type: 'user', cwd: project, message: { content: '<command-name>/model</command-name>' } },
      { type: 'user', cwd: project, message: { content: [{ type: 'text', text: 'Fix login' }] } },
      { type: 'custom-title', customTitle: 'Login bug' }
    );
    await writeClaude('bbb', project, {
      type: 'user',
      cwd: project,
      message: { content: 'Add tests' },
    });
    // Only meta/tool traffic: not a resumable conversation.
    await writeClaude('ccc', project, { type: 'user', isMeta: true, message: { content: 'x' } });

    const sessions = await listExternalSessions(project, { env, readers: noOpenCode });

    expect(bySessionId(sessions).map((s) => [s.providerId, s.sessionId, s.title])).toEqual([
      ['claude', 'aaa', 'Login bug'],
      ['claude', 'bbb', 'Add tests'],
    ]);
  });

  it('ignores Claude sessions whose recorded cwd differs despite a colliding directory', async () => {
    // "my.app" and "my-app" share a Claude project directory name.
    await writeClaude('ddd', project, {
      type: 'user',
      cwd: path.join(home, 'code', 'my-app'),
      message: { content: 'Other project' },
    });

    expect(await listExternalSessions(project, { env, readers: noOpenCode })).toEqual([]);
  });

  it('finds Codex sessions for the directory with index titles, skipping sub-agents', async () => {
    const userMessage = (text: string) => ({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'text', text }] },
      },
    });
    await writeCodex(
      'rollout-1.jsonl',
      { type: 'session_meta', payload: { id: 'x-1', cwd: project, thread_source: 'user' } },
      userMessage('Refactor the parser')
    );
    await writeCodex(
      'rollout-2.jsonl',
      { type: 'session_meta', payload: { id: 'x-2', cwd: project } },
      userMessage('Write docs')
    );
    await writeCodex(
      'rollout-3.jsonl',
      { type: 'session_meta', payload: { id: 'x-3', cwd: project, thread_source: 'subagent' } },
      userMessage('Sub task')
    );
    await writeCodex(
      'rollout-4.jsonl',
      { type: 'session_meta', payload: { id: 'x-4', cwd: path.join(home, 'elsewhere') } },
      userMessage('Other dir')
    );
    await writeFile(
      path.join(home, '.codex', 'session_index.jsonl'),
      jsonl({ id: 'x-2', thread_name: 'Docs pass' })
    );

    const sessions = await listExternalSessions(project, { env, readers: noOpenCode });

    expect(bySessionId(sessions).map((s) => [s.sessionId, s.title])).toEqual([
      ['x-1', 'Refactor the parser'],
      ['x-2', 'Docs pass'],
    ]);
  });

  it('drops excluded ids and survives a failing reader', async () => {
    await writeClaude('keep', project, { type: 'user', cwd: project, message: { content: 'a' } });
    await writeClaude('known', project, { type: 'user', cwd: project, message: { content: 'b' } });

    const sessions = await listExternalSessions(project, {
      env,
      exclude: new Set(['known']),
      readers: {
        opencode: () => {
          throw new Error('no database');
        },
      },
    });

    expect(sessions.map((s) => s.sessionId)).toEqual(['keep']);
  });

  it('passes both the given and resolved cwd to the OpenCode reader, newest first', async () => {
    const opencode = vi.fn<ExternalSessionReaders['opencode']>(() => [
      {
        providerId: 'opencode',
        sessionId: 'ses_old',
        title: 'old',
        firstMessage: null,
        updatedAt: 1,
        cwd: project,
      },
      {
        providerId: 'opencode',
        sessionId: 'ses_new',
        title: 'new',
        firstMessage: null,
        updatedAt: 9,
        cwd: project,
      },
    ]);

    const sessions = await listExternalSessions(project, { env, readers: { opencode } });

    expect(opencode.mock.calls[0]?.[1]).toEqual(new Set([project]));
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_new', 'ses_old']);
  });

  it('scans several directories at once and tags each session with its own', async () => {
    const worktree = path.join(project, '.claude', 'worktrees', 'feature-x');
    await mkdir(worktree, { recursive: true });
    await writeClaude('main-1', project, {
      type: 'user',
      cwd: project,
      message: { content: 'On the checkout' },
    });
    await writeClaude('wt-1', worktree, {
      type: 'user',
      cwd: worktree,
      message: { content: 'In the worktree' },
    });
    await writeCodex(
      'rollout-9.jsonl',
      { type: 'session_meta', payload: { id: 'x-wt', cwd: worktree } },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Codex in the worktree' },
      }
    );

    const sessions = await listExternalSessions([project, worktree], {
      env,
      readers: noOpenCode,
    });

    expect(bySessionId(sessions).map((s) => [s.sessionId, s.cwd])).toEqual([
      ['main-1', project],
      ['wt-1', worktree],
      ['x-wt', worktree],
    ]);
  });

  it('finds Pi and Oh My Pi sessions by their header cwd, preferring the OMP title line', async () => {
    const piDir = path.join(home, '.pi', 'agent', 'sessions', '--repo--');
    const ompDir = path.join(home, '.omp', 'agent', 'sessions', '-repo');
    await mkdir(piDir, { recursive: true });
    await mkdir(ompDir, { recursive: true });
    const message = (role: string, text: string) => ({
      type: 'message',
      message: { role, content: [{ type: 'text', text }] },
    });
    await writeFile(
      path.join(piDir, '2026-09-02T01-55-25Z_pi-1.jsonl'),
      jsonl({ type: 'session', id: 'pi-1', cwd: project }, message('user', 'ping'))
    );
    // Opened but never used: not listed.
    await writeFile(
      path.join(piDir, '2026-09-03T00-00-00Z_pi-empty.jsonl'),
      jsonl({ type: 'session', id: 'pi-empty', cwd: project })
    );
    await writeFile(
      path.join(ompDir, '2026-09-25T05-16-09Z_omp-1.jsonl'),
      jsonl(
        { type: 'title', v: 1, title: 'Fix sync' },
        { type: 'session', id: 'omp-1', cwd: project },
        message('user', 'sync is broken')
      )
    );
    await writeFile(
      path.join(ompDir, '2026-09-25T06-00-00Z_omp-other.jsonl'),
      jsonl({ type: 'session', id: 'omp-other', cwd: '/elsewhere' }, message('user', 'x'))
    );

    const sessions = await listExternalSessions(project, { env, readers: noOpenCode });

    expect(bySessionId(sessions).map((s) => [s.providerId, s.sessionId, s.title])).toEqual([
      ['oh-my-pi', 'omp-1', 'Fix sync'],
      ['pi', 'pi-1', 'ping'],
    ]);
  });
});
