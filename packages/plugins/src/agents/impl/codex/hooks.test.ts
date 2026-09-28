import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  CODEX_CONFIG_PATH,
  CODEX_LEGACY_HOOKS_PATH,
  buildCodexHookConfig,
  codexHookHash,
} from './hooks';

function createMemoryFs(initial: Record<string, string> = {}): PluginFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));

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

describe('buildCodexHookConfig', () => {
  it('writes Codex hooks to config.toml and removes legacy hooks.json', async () => {
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: 'model = "gpt-5"\n',
      [CODEX_LEGACY_HOOKS_PATH]: JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'curl http://127.0.0.1:$EMDASH_HOOK_PORT/hook',
                  },
                ],
              },
              {
                hooks: [{ type: 'command', command: 'echo user-stop' }],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [{ type: 'command', command: 'echo user-prompt' }],
              },
            ],
          },
        },
        null,
        2
      ),
    });
    const hooks = buildCodexHookConfig();

    await expect(hooks.writeHooks(fs, [])).resolves.toEqual([CODEX_CONFIG_PATH]);

    await expect(fs.exists(CODEX_LEGACY_HOOKS_PATH)).resolves.toBe(false);
    const config = await fs.read(CODEX_CONFIG_PATH);
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('echo user-stop');
    expect(config).toContain('echo user-prompt');
    expect(config).toContain('notification_type');
    expect(config).toContain('session-start');
  });

  it('keeps legacy hooks.json when writing config.toml fails', async () => {
    const legacyHooks = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo user-stop' }],
          },
        ],
      },
    });
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: 'model = "gpt-5"\n',
      [CODEX_LEGACY_HOOKS_PATH]: legacyHooks,
    });
    const write = fs.write.bind(fs);
    fs.write = async (path, content) => {
      if (path === CODEX_CONFIG_PATH) {
        throw new Error('permission denied');
      }
      await write(path, content);
    };
    const hooks = buildCodexHookConfig();

    await expect(hooks.writeHooks(fs, [])).rejects.toThrow('permission denied');

    await expect(fs.read(CODEX_LEGACY_HOOKS_PATH)).resolves.toBe(legacyHooks);
  });

  it('preserves Codex hook trust state while installing and deleting Emdash hooks', async () => {
    const trustKey = '/home/user/.codex/config.toml:stop:0:0';
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: `[hooks.state."${trustKey}"]
enabled = true
trusted_hash = "sha256:trusted"
`,
    });
    const hooks = buildCodexHookConfig();

    await expect(hooks.writeHooks(fs, [])).resolves.toEqual([CODEX_CONFIG_PATH]);
    await expect(hooks.getHooksInstalled(fs)).resolves.toBe(true);

    const installed = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
      hooks: {
        state: Record<string, { enabled?: boolean; trusted_hash?: string }>;
      };
    };
    expect(installed.hooks.state[trustKey]).toEqual({
      enabled: true,
      trusted_hash: 'sha256:trusted',
    });

    await hooks.deleteHooks(fs);

    const deleted = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
      hooks: {
        state: Record<string, { enabled?: boolean; trusted_hash?: string }>;
      };
    };
    expect(deleted.hooks.state[trustKey]).toEqual({
      enabled: true,
      trusted_hash: 'sha256:trusted',
    });
    expect(await hooks.getHooksInstalled(fs)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'marks its own hooks reviewed with the hash Codex records, keeping user hooks as they are',
    async () => {
      const fs = {
        ...createMemoryFs({
          [CODEX_CONFIG_PATH]: `[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "echo user-stop"

[hooks.state."/home/user/.codex/config.toml:stop:1:0"]
enabled = false
`,
        }),
        root: '/home/user/.codex',
      };
      const hooks = buildCodexHookConfig();
      // Written by an Emdash that did not mark its hooks reviewed yet.
      await hooks.writeHooks({ ...fs, root: undefined }, []);
      await expect(hooks.getHooksInstalled(fs)).resolves.toBe(false);

      await hooks.writeHooks(fs, []);
      await expect(hooks.getHooksInstalled(fs)).resolves.toBe(true);
      const config = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
        hooks: {
          Stop: Record<string, unknown>[];
          state: Record<string, { enabled?: boolean; trusted_hash?: string }>;
        };
      };
      // Hashes Codex itself recorded when these exact hooks were reviewed by hand.
      expect(config.hooks.state['/home/user/.codex/config.toml:stop:1:0']).toEqual({
        enabled: false,
        trusted_hash: 'sha256:cd0471cbdace6a9137ba1699388292eaeedf6222ad1cb562f79b51f0724e6343',
      });
      expect(config.hooks.state['/home/user/.codex/config.toml:session_start:0:0']).toEqual({
        trusted_hash: 'sha256:d6db1e47b489fc9cdaa74d07e965b069880372d7920eb79fabe87c86961b91af',
      });
      expect(
        config.hooks.state['/home/user/.codex/config.toml:permission_request:0:0']?.trusted_hash
      ).toBe('sha256:ccf0467f85fc0a9457b7cabc4d28e20bb89251aa7deceb9602165ad8ce3314d3');
      // The user's own hook is left for them to review.
      expect(config.hooks.Stop[0]).toEqual({
        hooks: [{ type: 'command', command: 'echo user-stop' }],
      });
      expect(Object.keys(config.hooks.state).some((key) => key.includes(':stop:0:'))).toBe(false);

      // A changed hook is a different hash, so Codex asks again.
      expect(
        codexHookHash('Stop', { hooks: [{ type: 'command', command: 'echo changed' }] })
      ).not.toBe(config.hooks.state['/home/user/.codex/config.toml:stop:1:0']?.trusted_hash);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keys the review by the canonical config path, as Codex does',
    async () => {
      const real = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
      const link = `${real}-link`;
      await symlink(real, link);
      try {
        const fs = { ...createMemoryFs(), root: link };
        await buildCodexHookConfig().writeHooks(fs, []);
        const config = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
          hooks: { state: Record<string, unknown> };
        };
        const keys = Object.keys(config.hooks.state);
        expect(keys).toContain(`${path.join(await realpath(real), 'config.toml')}:stop:0:0`);
        expect(keys.some((key) => key.startsWith(link))).toBe(false);
      } finally {
        await rm(link, { force: true });
        await rm(real, { recursive: true, force: true });
      }
    }
  );

  it('still validates Codex event hooks after separating trust state', async () => {
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: `[hooks.state."config.toml:stop:0:0"]
enabled = true

[hooks.Stop]
invalid = true
`,
    });

    await expect(buildCodexHookConfig().getHooksInstalled(fs)).rejects.toThrow(
      'expected "hooks.Stop" to be an array of objects'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'pipes the Codex session argument through to the hook request body',
    async () => {
      const fs = createMemoryFs();
      const hooks = buildCodexHookConfig();
      await hooks.writeHooks(fs, []);

      const config = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = config.hooks.SessionStart[0]?.hooks[0]?.command;
      expect(command).toBeDefined();

      const payload = '{"session_id":"session-1"}';
      const result = spawnSync(
        '/bin/sh',
        ['-c', `curl() { cat; }; ${command}`, 'codex-hook', payload],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            EMDASH_HOOK_PORT: '1234',
            EMDASH_HOOK_NONCE: 'nonce',
            EMDASH_PTY_ID: 'pty-1',
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(payload);
    }
  );

  it('deletes Emdash hooks from both current and legacy Codex hook config', async () => {
    const emdashHook = {
      hooks: [
        {
          type: 'command',
          command: 'curl http://127.0.0.1:$EMDASH_HOOK_PORT/hook',
        },
      ],
    };
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user-stop' }],
    };
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: `[[hooks.Stop]]
hooks = [{ type = "command", command = "curl http://127.0.0.1:$EMDASH_HOOK_PORT/hook" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "echo user-toml" }]
`,
      [CODEX_LEGACY_HOOKS_PATH]: JSON.stringify({
        hooks: {
          Stop: [emdashHook, userHook],
        },
      }),
    });
    const hooks = buildCodexHookConfig();

    await hooks.deleteHooks(fs);

    const config = await fs.read(CODEX_CONFIG_PATH);
    expect(config).not.toContain('EMDASH_HOOK_PORT');
    expect(config).toContain('echo user-toml');
    const legacy = await fs.read(CODEX_LEGACY_HOOKS_PATH);
    expect(legacy).toContain('echo user-stop');
    expect(legacy).not.toContain('EMDASH_HOOK_PORT');
  });
});
