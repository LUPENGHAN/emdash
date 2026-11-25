import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { secret, type Secret } from '@emdash/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { withAgentEffort } from '@core/features/model-providers/api/node/agent-effort';
import {
  ensureCodexModelCatalog,
  codexModelCatalogPath,
  codexAppServerWrapperPath,
} from '@core/features/model-providers/api/node/codex-launch';
import { buildSourceLaunch } from '@core/features/model-providers/api/node/source-launch';
import type { GatewayUsage } from '../api/contract';
import {
  gatewayModelsSettingsSchema,
  migrateGatewayModelsV1,
  type GatewayModel,
} from '../api/model-catalog';
import { startAcpTestClient } from './acp-test-client';
import {
  ModelGatewayService,
  type GatewayRoute,
  type GatewayDependencies,
} from './gateway-service';

function store<T>() {
  const data = new Map<string, T>();
  return {
    getOrThrow: async (key: string) => data.get(key) ?? null,
    setOrThrow: async (key: string, value: T) => {
      data.set(key, structuredClone(value));
    },
    getAll: async () => Object.fromEntries(data),
    clear: async () => {
      data.clear();
    },
  };
}
const resources = resolve('../model-gateway/dist');
const binary = join(
  resources,
  `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`,
  process.platform === 'win32' ? 'model-gateway.exe' : 'model-gateway'
);
const built = await access(binary).then(
  () => true,
  () => false
);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('model gateway provider reconciliation', () => {
  it('removes catalog sources whose provider was already deleted', async () => {
    const orphan: GatewayModel = {
      id: 'orphan-model',
      alias: 'orphan',
      name: 'Orphan',
      enabled: true,
      revision: 1,
      providerId: 'deleted-provider',
      protocolModels: { 'openai-responses': { upstreamModel: 'orphan' } },
      protocolPolicy: { mode: 'auto' },
    };
    let settings = gatewayModelsSettingsSchema.parse(
      migrateGatewayModelsV1({ version: 1, models: [orphan] })
    );
    const vault = new Map<string, string>();
    const service = new ModelGatewayService({
      binary,
      dataDir: tmpdir(),
      getModels: async () => settings,
      saveModels: async (next) => {
        settings = structuredClone(next);
      },
      inventory: async () => [],
      secrets: {
        getSecret: async (key): Promise<Secret<string> | null> =>
          vault.has(key) ? secret(vault.get(key)!, key) : null,
        setSecret: async (key, value) => {
          vault.set(key, value.expose());
        },
        deleteSecret: async (key) => {
          vault.delete(key);
        },
      },
      routes: store<GatewayRoute>(),
      ledger: store<GatewayUsage>(),
      conversationIdle: async () => true,
      conversationLocal: async () => true,
    });

    await expect(service.reconcileProviderInventory()).resolves.toMatchObject({
      removedModels: 1,
      removedSources: 1,
    });
    expect(settings.models).toEqual([]);
  });

  it('explicitly deletes a model while preserving historical route snapshots', async () => {
    const savedModel: GatewayModel = {
      id: 'saved-model',
      alias: 'saved',
      name: 'Saved',
      enabled: true,
      revision: 1,
      providerId: 'provider',
      protocolModels: { 'openai-responses': { upstreamModel: 'saved' } },
      protocolPolicy: { mode: 'auto' },
    };
    let settings = gatewayModelsSettingsSchema.parse(
      migrateGatewayModelsV1({ version: 1, models: [savedModel] })
    );
    const routes = store<GatewayRoute>();
    const historicalRoute: GatewayRoute = {
      sourceId: 'gateway:models',
      model: savedModel.alias,
      catalog: { agent: 'codex', models: [savedModel], providers: [] },
    };
    await routes.setOrThrow('history', historicalRoute);
    const vault = new Map<string, string>();
    const service = new ModelGatewayService({
      binary,
      dataDir: tmpdir(),
      getModels: async () => settings,
      saveModels: async (next) => {
        settings = structuredClone(next);
      },
      inventory: async () => [],
      secrets: {
        getSecret: async (key): Promise<Secret<string> | null> =>
          vault.has(key) ? secret(vault.get(key)!, key) : null,
        setSecret: async (key, value) => {
          vault.set(key, value.expose());
        },
        deleteSecret: async (key) => {
          vault.delete(key);
        },
      },
      routes,
      ledger: store<GatewayUsage>(),
      conversationIdle: async () => true,
      conversationLocal: async () => true,
    });

    await expect(service.deleteModel('saved-model')).resolves.toEqual({ deleted: true });
    expect(settings.models).toEqual([]);
    expect(await routes.getOrThrow('history')).toEqual(historicalRoute);
    await expect(service.deleteModel('saved-model')).resolves.toEqual({ deleted: false });
  });
});

describe.runIf(built)('model gateway process integration', () => {
  it('saves providers securely, keeps concurrent session routes isolated, resumes after a process stop, and retains usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-gateway-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const seen: Array<{
      upstream: string;
      model: string;
      input: unknown;
      authorization: string | undefined;
      effort?: string;
    }> = [];
    const backend = async (name: string) => {
      const server = createServer((req, res) => {
        void (async () => {
          const parts = [];
          for await (const part of req) parts.push(Buffer.from(part));
          const payload = JSON.parse(Buffer.concat(parts).toString()) as {
            model: string;
            input: unknown;
            reasoning?: { effort?: string };
          };
          seen.push({
            upstream: name,
            model: payload.model,
            input: payload.input,
            authorization: req.headers.authorization,
            effort: payload.reasoning?.effort,
          });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const response = {
            id: 'r',
            object: 'response',
            status: 'completed',
            model: payload.model,
            output: [
              {
                id: 'msg',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: name, annotations: [] }],
              },
            ],
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              total_tokens: 10,
              input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
            },
          };
          const emit = (type: string, value: Record<string, unknown>) =>
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
          emit('response.created', {
            response: { ...response, status: 'in_progress', output: [] },
          });
          emit('response.output_item.added', {
            output_index: 0,
            item: { ...response.output[0], status: 'in_progress', content: [] },
          });
          emit('response.output_text.delta', {
            item_id: 'msg',
            output_index: 0,
            content_index: 0,
            delta: name,
          });
          emit('response.output_item.done', { output_index: 0, item: response.output[0] });
          emit('response.completed', { response });
          res.end();
        })().catch(() => res.destroy());
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      cleanup.push(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          })
      );
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('No listener');
      return `http://127.0.0.1:${bound.port}`;
    };
    const a = await backend('A');
    const b = await backend('B');
    const vault = new Map<string, string>();
    let idle = true;
    let localConversation = true;
    const routes = store<GatewayRoute>();
    const ledger = store<GatewayUsage>();
    let failLedger = false;
    const deps: GatewayDependencies = {
      binary,
      inventory: async () => [
        {
          provider: {
            id: 'provider-a',
            name: new URL(a).host,
            protocol: 'openai-responses',
            baseUrl: a,
            models: ['test'],
            modelAliases: { test: 'upstream' },
          },
          apiKey: 'fake-provider-A',
        },
        {
          provider: {
            id: 'provider-b',
            name: new URL(b).host,
            protocol: 'openai-responses',
            baseUrl: b,
            models: ['test'],
            modelAliases: { test: 'upstream' },
          },
          apiKey: 'fake-provider-B',
        },
      ],
      dataDir: dir,
      secrets: {
        getSecret: async (key): Promise<Secret<string> | null> =>
          vault.has(key) ? secret(vault.get(key)!, key) : null,
        setSecret: async (key, value) => {
          vault.set(key, value.expose());
        },
        deleteSecret: async (key) => {
          vault.delete(key);
        },
      },
      routes,
      ledger: {
        ...ledger,
        setOrThrow: async (key, value) => {
          if (failLedger) throw new Error('Simulated ledger failure');
          await ledger.setOrThrow(key, value);
        },
      },
      conversationIdle: async () => idle,
      conversationLocal: async () => localConversation,
    };
    const service = new ModelGatewayService(deps);
    cleanup.push(() => service.dispose());
    await service.restore();
    const status = await service.status();
    expect(status.providers, JSON.stringify(status)).toHaveLength(2);
    const providerA = status.providers.find((p) => p.name.includes(new URL(a).host))!;
    const providerB = status.providers.find((p) => p.name.includes(new URL(b).host))!;
    const first = await service.prepareLaunch(providerA.id, 'test', 'one');
    const second = await service.prepareLaunch(providerA.id, 'test', 'two');
    const send = async (target: typeof first) => {
      const res = await fetch(target.provider.baseUrl + '/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', input: 'remember context', stream: true }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      return text;
    };
    expect(await send(first)).toContain('completed');
    idle = false;
    await service.switchRoute({ conversationId: 'one', sourceId: providerB.id, model: 'test' });
    expect((await service.route('one'))?.pending?.sourceId).toBe(providerB.id);
    expect((await service.route('one'))?.sourceId).toBe(providerA.id);
    idle = true;
    await new Promise((done) => setTimeout(done, 600));
    expect((await service.route('one'))?.pending).toBeUndefined();
    await Promise.all([send(first), send(second)]);
    expect(seen[0].upstream).toBe('A');
    expect(
      seen
        .slice(1)
        .map((v) => v.upstream)
        .sort()
    ).toEqual(['A', 'B']);
    expect(seen.every((v) => v.model === 'upstream')).toBe(true);
    expect(seen.every((v) => v.authorization === `Bearer fake-provider-${v.upstream}`)).toBe(true);
    failLedger = true;
    await send(first);
    await service.stop();
    failLedger = false;
    await service.start();
    await send(first);
    expect(seen.at(-1)?.upstream).toBe('B');
    const deadline = Date.now() + 3000;
    while ((await service.usage(100)).length < 5 && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 20));
    expect(await service.usage(100), JSON.stringify(await service.usage(100))).toHaveLength(5);
    expect((await service.status()).usageError).toBeUndefined();
    expect((await service.usage(100))[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });
    // Exercise the actual Codex CLI and the bundled ACP adapter through the product service.
    const codex = process.env.EMDASH_CODEX_TEST_BINARY ?? 'codex';
    const cli = await promisify(execFile)(codex, ['--version']).then(
      () => true,
      () => false
    );
    if (process.env.EMDASH_CODEX_TEST_BINARY) expect(cli).toBe(true);
    if (cli) {
      const cliTarget = await service.prepareLaunch(providerA.id, 'test', 'cli-probe');
      const launch = buildSourceLaunch(
        'codex',
        { ...cliTarget.provider, models: [] },
        cliTarget.apiKey,
        'test'
      );
      if (!launch) throw new Error('No Codex launch');
      const selection = withAgentEffort('codex', { env: launch.env, effort: 'high' });
      const home = join(dir, 'codex-cli');
      await mkdir(home);
      const env = {
        ...process.env,
        ...selection?.env,
        CODEX_HOME: home,
        OTEL_SDK_DISABLED: 'true',
      };
      const runCodex = (args: string[]) => {
        const result = promisify(execFile)(codex, args, { cwd: dir, env, timeout: 40000 });
        result.child.stdin?.end();
        return result;
      };
      const first = await runCodex([
        'exec',
        '--skip-git-repo-check',
        '--json',
        ...launch.args,
        ...(selection?.extraArgs ?? '').split(' ').filter(Boolean),
        'remember product-cli-marker',
      ]);
      expect(seen.at(-1)?.effort).toBe('high');
      const started = first.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; thread_id?: string })
        .find((l) => l.type === 'thread.started');
      expect(started?.thread_id).toBeTruthy();
      await service.switchRoute({
        conversationId: 'cli-probe',
        sourceId: providerB.id,
        model: 'test',
      });
      const resumed = await runCodex([
        'exec',
        '--skip-git-repo-check',
        '--json',
        ...launch.args,
        ...(selection?.extraArgs ?? '').split(' ').filter(Boolean),
        'resume',
        started!.thread_id!,
        'repeat the marker',
      ]);
      expect(resumed.stdout).toContain(started!.thread_id);
      expect(seen.at(-1)?.effort).toBe('high');
      expect(
        seen.some(
          (v) => v.upstream === 'B' && JSON.stringify(v.input).includes('product-cli-marker')
        )
      ).toBe(true);
      const acpTarget = await service.prepareLaunch(providerA.id, 'test', 'acp-probe');
      const acpLaunch = buildSourceLaunch('codex', acpTarget.provider, acpTarget.apiKey, 'test');
      if (!acpLaunch) throw new Error('No ACP launch');
      const acpSelection = withAgentEffort('codex', { env: acpLaunch.env, effort: 'high' });
      const acpHome = join(dir, 'codex-acp');
      await mkdir(acpHome);
      if (!acpLaunch.codexCatalog) throw new Error('No ACP model catalog');
      await ensureCodexModelCatalog(acpLaunch.codexCatalog, acpHome);
      const catalogFile = codexModelCatalogPath(acpLaunch.codexCatalog, acpHome);
      const adapter = resolve('out/main/adapters/codex-acp.cjs');
      const adapterBuilt = await access(adapter).then(
        () => true,
        () => false
      );
      if (process.env.EMDASH_CODEX_TEST_BINARY) expect(adapterBuilt).toBe(true);
      if (adapterBuilt) {
        const acp = startAcpTestClient(adapter, dir, {
          ...process.env,
          ...acpSelection?.env,
          EMDASH_CODEX_MODEL_CATALOG: catalogFile,
          CODEX_CONFIG: JSON.stringify({
            ...JSON.parse(acpSelection?.env?.CODEX_CONFIG ?? '{}'),
            model_catalog_json: catalogFile,
          }),
          CODEX_HOME: acpHome,
          CODEX_PATH: codexAppServerWrapperPath(acpHome),
          EMDASH_CODEX_BIN: codex,
          OTEL_SDK_DISABLED: 'true',
        });
        try {
          await acp.call('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'emdash-gateway-test', version: '1' },
          });
          await acp.call('authenticate', JSON.parse(acpLaunch.env.DEFAULT_AUTH_REQUEST));
          const session = (await acp.call('session/new', { cwd: dir, mcpServers: [] })) as {
            sessionId: string;
          };
          expect(
            await acp.call('session/prompt', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'remember product-acp-marker' }],
            })
          ).toMatchObject({ stopReason: 'end_turn' });
          expect(seen.at(-1)?.effort).toBe('high');
          await service.switchRoute({
            conversationId: 'acp-probe',
            sourceId: providerB.id,
            model: 'test',
          });
          expect(
            await acp.call('session/prompt', {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: 'repeat the marker' }],
            })
          ).toMatchObject({ stopReason: 'end_turn' });
          expect(seen.at(-1)?.effort).toBe('high');
          expect(
            seen.some(
              (v) => v.upstream === 'B' && JSON.stringify(v.input).includes('product-acp-marker')
            )
          ).toBe(true);
        } finally {
          await acp.close();
        }
      }
    }
    const opencode = process.env.EMDASH_OPENCODE_TEST_BINARY;
    if (opencode) {
      await promisify(execFile)(opencode, ['--version']);
      const opencodeTarget = await service.prepareLaunch(providerA.id, 'test', 'opencode-probe');
      const launch = buildSourceLaunch(
        'opencode',
        opencodeTarget.provider,
        opencodeTarget.apiKey,
        'test'
      );
      if (!launch) throw new Error('No OpenCode gateway launch');
      const home = join(dir, 'opencode-native');
      await mkdir(home);
      const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
      config.enabled_providers = ['emdash-gateway'];
      const env = {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        XDG_CACHE_HOME: join(home, 'cache'),
        ...launch.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: join(home, 'config', 'opencode'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        DO_NOT_TRACK: '1',
        CI: 'true',
      };
      const native = await promisify(execFile)(
        opencode,
        [
          '--standalone',
          'run',
          '--format',
          'json',
          '--model',
          config.model,
          'remember native-opencode-cli-marker',
        ],
        { cwd: home, env, timeout: 40_000 }
      );
      expect(native.stdout).toMatch(/"text"\s*:\s*"A"/);
      expect(
        seen.some(
          (request) =>
            request.upstream === 'A' &&
            request.model === 'upstream' &&
            JSON.stringify(request.input).includes('native-opencode-cli-marker')
        )
      ).toBe(true);
      const acp = startAcpTestClient(opencode, home, env, ['acp']);
      try {
        await acp.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'emdash-native-opencode-test', version: '1' },
        });
        const session = (await acp.call('session/new', { cwd: home, mcpServers: [] })) as {
          sessionId: string;
        };
        expect(
          await acp.call('session/prompt', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'remember native-opencode-acp-marker' }],
          })
        ).toMatchObject({ stopReason: 'end_turn' });
        expect(
          seen.some(
            (request) =>
              request.upstream === 'A' &&
              request.model === 'upstream' &&
              JSON.stringify(request.input).includes('native-opencode-acp-marker')
          )
        ).toBe(true);
      } finally {
        await acp.close();
      }
    }
    expect(
      (
        await fetch(first.provider.baseUrl + '/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${second.apiKey}` },
          body: '{}',
        })
      ).status
    ).toBe(401);
    localConversation = false;
    expect(
      (
        await fetch(first.provider.baseUrl + '/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${first.apiKey}` },
          body: '{}',
        })
      ).status
    ).toBe(404);
    localConversation = true;
    await expect.poll(async () => (await service.usage(100)).length).toBe(seen.length);
    const recorded = await service.usage(100);
    await routes.clear();
    expect(await service.usage(100)).toEqual(recorded);
    expect(
      (
        await fetch(first.provider.baseUrl + '/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${first.apiKey}` },
          body: '{}',
        })
      ).status
    ).toBe(404);
    const masked = JSON.stringify(await service.status());
    expect(masked).not.toContain('fake-provider');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(dir, entry.name));
      expect(bytes.includes(Buffer.from('fake-provider'))).toBe(false);
    }
    await service.dispose();
    const restored = new ModelGatewayService(deps);
    cleanup.push(() => restored.dispose());
    await restored.restore();
    expect((await restored.status()).providers).toHaveLength(2);
    expect(await restored.usage(100)).toEqual(recorded);
  }, 120000);
});
