import * as nodeModule from 'node:module';
import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provider } from './index';

function createMemoryFs(): PluginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async delete(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(path) {
      return [...files.keys()].filter((file) => file.startsWith(path));
    },
  };
}

type TestContext = {
  agent?: { kind: 'main' | 'sub' };
  sessionManager: { getSessionId: () => string; getSessionFile: () => string };
};

type TestHandler = (event: Record<string, unknown>, context: TestContext) => Promise<void>;

async function createExtensionHarness() {
  vi.stubEnv('EMDASH_HOOK_PORT', '9876');
  vi.stubEnv('EMDASH_HOOK_NONCE', 'nonce');
  vi.stubEnv('EMDASH_PTY_ID', 'pty-1');
  vi.stubEnv('EMDASH_AGENT_PROVIDER', '');
  vi.stubEnv('EMDASH_AGENT_MODEL', '');
  const fetchMock = vi.fn().mockResolvedValue(new Response());
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process, 'once').mockImplementation(() => process);

  const fs = createMemoryFs();
  await provider.behavior.plugins?.installPlugin(fs, { kind: 'global' });
  const content = await fs.read('extensions/emdash-hook.ts');
  if (!content) throw new Error('OMP extension was not installed');
  // The workspace pins Node 24, but its shared Node types predate this API.
  const { stripTypeScriptTypes } = nodeModule as typeof nodeModule & {
    stripTypeScriptTypes: (code: string) => string;
  };
  const source = Buffer.from(stripTypeScriptTypes(content)).toString('base64');
  const extension = await import(`data:text/javascript;base64,${source}#${crypto.randomUUID()}`);

  function createInstance(kind: 'main' | 'sub' = 'main', includeAgent = true) {
    const handlers = new Map<string, TestHandler>();
    extension.default({
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    });
    const context: TestContext = {
      ...(includeAgent && { agent: { kind } }),
      sessionManager: { getSessionId: () => kind, getSessionFile: () => `${kind}.jsonl` },
    };
    return {
      async emit(event: string, payload: Record<string, unknown> = {}) {
        const handler = handlers.get(event);
        if (!handler) throw new Error(`Missing ${event} handler`);
        await handler(payload, context);
      },
    };
  }

  function events() {
    return fetchMock.mock.calls.map(([, init]) => {
      const request = init as RequestInit;
      return {
        type: new Headers(request.headers).get('X-Emdash-Event-Type'),
        body: JSON.parse(request.body as string),
      };
    });
  }

  return { createInstance, events };
}

describe('oh-my-pi plugin hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('resolves the OMP agent directory from its documented environment hierarchy', () => {
    const resolveConfigRoot = provider.behavior.plugins?.resolveConfigRoot;
    expect(resolveConfigRoot).toBeDefined();

    expect(resolveConfigRoot?.({ env: {}, homeDir: '/home/ada', platform: 'linux' })).toBe(
      '/home/ada/.omp/agent'
    );
    expect(
      resolveConfigRoot?.({
        env: { PI_CONFIG_DIR: '.custom-omp' },
        homeDir: '/home/ada',
        platform: 'linux',
      })
    ).toBe('/home/ada/.custom-omp/agent');
    expect(
      resolveConfigRoot?.({
        env: {
          PI_CODING_AGENT_DIR: '/configs/omp-agent',
          PI_CONFIG_DIR: '.ignored',
        },
        homeDir: '/home/ada',
        platform: 'linux',
      })
    ).toBe('/configs/omp-agent');
  });

  it('updates a stale managed extension and preserves the session id integration', async () => {
    const fs = createMemoryFs();
    await fs.write('extensions/emdash-hook.ts', '// stale extension');
    await expect(
      provider.behavior.plugins?.isPluginInstalled(fs, { kind: 'global' })
    ).resolves.toBe(false);

    const written = await provider.behavior.plugins?.installPlugin(fs, { kind: 'global' });

    expect(written).toEqual(['extensions/emdash-hook.ts']);
    const content = await fs.read('extensions/emdash-hook.ts');
    expect(content).toContain("pi.on('session_stop'");
    // The session id, which `omp acp` loads (not the file path).
    expect(content).toContain('getSessionId?.()');
    expect(content).not.toContain('providerSessionId: event.session_file');
    expect(content).toContain("notifyEmdash('stop'");
    await expect(
      provider.behavior.plugins?.isPluginInstalled(fs, { kind: 'global' })
    ).resolves.toBe(true);
  });

  it('reports exactly one completion for each of two turns', async () => {
    const { createInstance, events } = await createExtensionHarness();
    const main = createInstance();
    await main.emit('session_start');
    for (let turn = 0; turn < 2; turn++) {
      await main.emit('agent_start');
      await main.emit('session_stop');
      await main.emit('agent_end');
      await main.emit('agent_end');
    }
    await main.emit('session_shutdown');

    expect(events().map((event) => event.type)).toEqual([
      'session',
      'session',
      'stop',
      'session',
      'stop',
    ]);
    expect(events()[0]?.body).toEqual({ providerSessionId: 'main' });
  });

  it('waits for the terminal agent_end when a stop hook schedules continuation', async () => {
    const { createInstance, events } = await createExtensionHarness();
    const main = createInstance();
    await main.emit('session_start');
    await main.emit('agent_start');
    await main.emit('session_stop');
    await main.emit('agent_end', { willContinue: true });
    expect(events().some((event) => event.type === 'stop')).toBe(false);
    await main.emit('agent_start');
    await main.emit('agent_end', { willContinue: true, awaitingAsyncWork: true });
    expect(events().some((event) => event.type === 'stop')).toBe(false);
    await main.emit('agent_start');
    await main.emit('session_stop');
    await main.emit('agent_end', { willContinue: false });
    expect(events().filter((event) => event.type === 'stop')).toHaveLength(1);
  });

  it('does not let a subagent complete or change the main session', async () => {
    const { createInstance, events } = await createExtensionHarness();
    const main = createInstance();
    const sub = createInstance('sub');
    await main.emit('session_start');
    await main.emit('agent_start');
    await sub.emit('session_start');
    await sub.emit('agent_start');
    await sub.emit('session_stop');
    await sub.emit('agent_end');
    await sub.emit('session_shutdown');
    expect(events()).toEqual([{ type: 'session', body: { providerSessionId: 'main' } }]);
    await main.emit('agent_end');
    expect(events().filter((event) => event.type === 'stop')).toHaveLength(1);
  });

  it('keeps completion state independent between extension instances', async () => {
    const { createInstance, events } = await createExtensionHarness();
    const first = createInstance();
    const second = createInstance();
    await first.emit('agent_start');
    await second.emit('agent_start');
    await first.emit('agent_end');
    await second.emit('agent_end');
    expect(events().filter((event) => event.type === 'stop')).toHaveLength(2);
  });

  it('accepts contexts without an agent identity', async () => {
    const { createInstance, events } = await createExtensionHarness();
    const main = createInstance('main', false);
    await main.emit('session_start');
    await main.emit('agent_start');
    await main.emit('agent_end');
    expect(events().filter((event) => event.type === 'stop')).toHaveLength(1);
  });

  it('reports session shutdown once when no completion was sent', async () => {
    const { createInstance, events } = await createExtensionHarness();
    const main = createInstance();
    await main.emit('session_start');
    await main.emit('agent_start');
    await main.emit('session_shutdown');
    await main.emit('agent_end');
    expect(events().filter((event) => event.type === 'stop')).toEqual([
      { type: 'stop', body: { message: 'Session ended' } },
    ]);
  });
});

describe('oh-my-pi chat sessions', () => {
  it('recognizes the missing-session error of omp acp', () => {
    const check = provider.behavior.acp?.isSessionNotFound;
    const error = {
      code: -32603,
      message: 'Internal error',
      data: { details: 'ACP session not found: 01a0efbd' },
    };
    expect(check?.(error, '01a0efbd')).toBe(true);
    expect(check?.(error, 'other')).toBe(false);
    expect(check?.({ code: -32603, message: 'Internal error' }, '01a0efbd')).toBe(false);
  });
});
