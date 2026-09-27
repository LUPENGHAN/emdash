import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAgentSession } from './delete-agent-session';

describe('deleteAgentSession', () => {
  let home: string;
  const trashed: string[] = [];
  const deps = () => ({
    env: { home, env: {} },
    trash: async (target: string) => {
      trashed.push(path.relative(home, target));
    },
  });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'delete-agent-session-'));
    trashed.length = 0;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function file(relative: string, content = '{}\n') {
    const full = path.join(home, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  it('trashes a Claude transcript and its sub-agent folder, wherever the cwd folder is', async () => {
    await file('.claude/projects/-Users-me-repo/abc.jsonl');
    await file('.claude/projects/-Users-me-repo/abc/subagents/x.jsonl');
    await file('.claude/projects/-Users-me-repo/other.jsonl');
    expect(await deleteAgentSession('claude', 'abc', deps())).toBe(2);
    expect(trashed.sort()).toEqual([
      '.claude/projects/-Users-me-repo/abc',
      '.claude/projects/-Users-me-repo/abc.jsonl',
    ]);
  });

  it('trashes Codex rollouts, live or archived, by the id in their name', async () => {
    await file('.codex/sessions/2026/09/27/rollout-2026-09-27T10-00-00-019a-id.jsonl');
    await file('.codex/archived_sessions/rollout-2026-09-01T10-00-00-019a-id.jsonl');
    await file('.codex/sessions/2026/09/27/rollout-2026-09-27T11-00-00-other.jsonl');
    expect(await deleteAgentSession('codex', '019a-id', deps())).toBe(2);
  });

  it('finds Pi sessions by their header and Cursor sessions by folder', async () => {
    await file(
      '.pi/agent/sessions/--repo--/2026_x.jsonl',
      `${JSON.stringify({ type: 'session', id: 'pi-1', cwd: '/repo' })}\n`
    );
    await file(
      '.pi/agent/sessions/--repo--/2026_y.jsonl',
      `${JSON.stringify({ type: 'session', id: 'pi-2', cwd: '/repo' })}\n`
    );
    expect(await deleteAgentSession('pi', 'pi-1', deps())).toBe(1);
    expect(trashed).toEqual(['.pi/agent/sessions/--repo--/2026_x.jsonl']);

    await file('.cursor/chats/hash/chat-1/meta.json');
    await file('.cursor/acp-sessions/chat-1/meta.json');
    expect(await deleteAgentSession('cursor', 'chat-1', deps())).toBe(2);
  });

  it('asks OpenCode to delete its own record', async () => {
    const runOpenCode = vi.fn(async () => {});
    await deleteAgentSession('opencode', 'ses_1', { ...deps(), runOpenCode });
    expect(runOpenCode).toHaveBeenCalledWith(['session', 'delete', 'ses_1']);
  });

  it('refuses ids that could name other files, and reports nothing found', async () => {
    await expect(deleteAgentSession('claude', '../x', deps())).rejects.toThrow('Invalid');
    await expect(deleteAgentSession('claude', '..', deps())).rejects.toThrow('Invalid');
    expect(await deleteAgentSession('claude', 'missing', deps())).toBe(0);
    expect(trashed).toEqual([]);
  });
});
