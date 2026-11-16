import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { secret } from '@emdash/shared';
import { expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import { buildSourceLaunch } from '@core/features/model-providers/api/node/source-launch';
import type { GatewayUsage } from '../api/contract';
import { catalogSourceId, type GatewayModelsSettings } from '../api/model-catalog';
import { startAcpTestClient } from './acp-test-client';
import { ModelGatewayService, type GatewayRoute } from './gateway-service';

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

it('routes native protocols and explicit model choices through the Go process, preserves revisions and records actual usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'emdash-catalog-'));
  const seen: Array<{ path: string; model: string; key: string | undefined }> = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const raw = Buffer.concat(parts).toString();
      if (!raw) {
        res.end();
        return;
      }
      const body = JSON.parse(raw) as { model: string; stream?: boolean };
      seen.push({ path: req.url!, model: body.model, key: req.headers.authorization });
      if (body.stream && req.url?.includes('/chat/completions')) {
        res.setHeader('content-type', 'text/event-stream');
        res.end(
          `data: ${JSON.stringify({ id: 'chat_cli', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'gateway-cli-ok' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chat_cli', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`
        );
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/messages'))
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'native' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 4, output_tokens: 2 },
          })
        );
      else if (req.url?.includes('/chat/completions'))
        res.end(
          JSON.stringify({
            id: 'chat_1',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'converted' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          })
        );
      else
        res.end(
          JSON.stringify({
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            model: body.model,
            output: [],
            usage: { input_tokens: 4, output_tokens: 2 },
          })
        );
    })().catch(() => res.destroy());
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  let providers: ModelProvider[] = [
    {
      id: 'p1',
      name: 'Provider one',
      baseUrl: base,
      endpoints: {
        anthropic: `${base}/anthropic`,
        'openai-responses': `${base}/responses/v1`,
        'openai-chat': `${base}/chat/v1`,
      },
      models: [],
    },
    {
      id: 'p2',
      name: 'Provider two',
      baseUrl: `${base}/alternate/v1`,
      protocol: 'openai-chat',
      models: [],
    },
  ];
  let settings: GatewayModelsSettings = {
    version: 1,
    models: [
      {
        id: 'both-id',
        alias: 'both',
        name: 'Both protocols',
        enabled: true,
        revision: 1,
        providerId: 'p1',
        protocolModels: {
          anthropic: { upstreamModel: 'physical-messages' },
          'openai-responses': { upstreamModel: 'physical-responses' },
        },
        protocolPolicy: { mode: 'auto' },
      },
      {
        id: 'chat-id',
        alias: 'chat-only',
        name: 'Chat model',
        enabled: true,
        revision: 1,
        providerId: 'p2',
        protocolModels: { 'openai-chat': { upstreamModel: 'physical-chat' } },
        protocolPolicy: { mode: 'auto' },
      },
    ],
  };
  const vault = new Map<string, string>();
  let idle = true;
  let key = 'fake-key';
  const routes = store<GatewayRoute>();
  const service = new ModelGatewayService({
    binary: resolve(
      `../model-gateway/dist/${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}/model-gateway${process.platform === 'win32' ? '.exe' : ''}`
    ),
    dataDir: dir,
    routes,
    ledger: store<GatewayUsage>(),
    getModels: async () => structuredClone(settings),
    saveModels: async (next) => {
      settings = structuredClone(next);
    },
    inventory: async () =>
      providers.map((provider) => ({
        provider,
        apiKey: key,
        protocolKeys:
          provider.id === 'p1'
            ? { anthropic: key + '-anthropic', 'openai-responses': key + '-responses' }
            : undefined,
      })),
    conversationIdle: async () => idle,
    conversationLocal: async () => true,
    secrets: {
      getSecret: async (name) => (vault.has(name) ? secret(vault.get(name)!, name) : null),
      setSecret: async (name, value) => {
        vault.set(name, value.expose());
      },
      deleteSecret: async (name) => {
        vault.delete(name);
      },
    },
  });
  try {
    const claude = await service.prepareLaunch(
      catalogSourceId,
      'both',
      'claude-conversation',
      'claude'
    );
    const codex = await service.prepareLaunch(
      catalogSourceId,
      'both',
      'codex-conversation',
      'codex'
    );
    expect(claude.provider.models).toEqual(['both', 'chat-only']);
    const send = async (
      target: typeof claude,
      protocol: 'anthropic' | 'responses',
      model = 'both'
    ) => {
      const res = await fetch(
        target.provider.baseUrl + (protocol === 'anthropic' ? '/v1/messages' : '/responses'),
        {
          method: 'POST',
          headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(
            protocol === 'anthropic'
              ? { model, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }
              : { model, input: 'hello', store: false }
          ),
        }
      );
      const body = await res.text();
      expect(res.status, body).toBe(200);
      return body;
    };
    await Promise.all([send(claude, 'anthropic'), send(codex, 'responses')]);
    expect(seen).toEqual(
      expect.arrayContaining([
        {
          path: '/anthropic/v1/messages',
          model: 'physical-messages',
          key: 'Bearer fake-key-anthropic',
        },
        {
          path: '/responses/v1/responses',
          model: 'physical-responses',
          key: 'Bearer fake-key-responses',
        },
      ])
    );
    expect(await send(codex, 'responses', 'chat-only')).toContain('converted');
    expect(seen.at(-1)).toMatchObject({
      path: '/alternate/v1/chat/completions',
      model: 'physical-chat',
    });
    const list = await fetch(claude.provider.baseUrl + '/v1/models', {
      headers: { authorization: `Bearer ${claude.apiKey}` },
    });
    expect(await list.json()).toMatchObject({ data: [{ id: 'both' }, { id: 'chat-only' }] });
    await expect(
      service.prepareLaunch(catalogSourceId, undefined, undefined, 'claude')
    ).rejects.toThrow('Select an available');
    idle = false;
    await service.saveModels(
      settings.models.map((m) => (m.id === 'both-id' ? { ...m, name: 'Display rename' } : m))
    );
    expect((await service.route('claude-conversation'))?.catalog?.models[0].name).toBe(
      'Both protocols'
    );
    idle = true;
    expect((await service.route('claude-conversation'))?.catalog?.models[0].name).toBe(
      'Display rename'
    );
    key = 'rotated-key';
    await send(claude, 'anthropic');
    expect(seen.at(-1)?.key).toBe('Bearer rotated-key-anthropic');
    await service.saveModels(
      settings.models.map((m) =>
        m.id === 'both-id'
          ? {
              ...m,
              providerId: 'p2',
              protocolModels: { 'openai-chat': { upstreamModel: 'replacement-chat' } },
            }
          : m
      )
    );
    expect(await service.route('claude-conversation')).toMatchObject({ requiresNewSession: true });
    await send(claude, 'anthropic');
    expect(seen.at(-1)?.model).toBe('physical-messages');
    const replacement = await service.prepareLaunch(
      catalogSourceId,
      'both',
      'replacement',
      'claude'
    );
    expect(await send(replacement, 'anthropic')).toContain('converted');
    expect(seen.at(-1)?.model).toBe('replacement-chat');
    await service.stop();
    await service.start();
    await send(claude, 'anthropic');
    expect(seen.at(-1)?.model).toBe('physical-messages');
    await expect.poll(async () => (await service.usage(100)).length).toBe(7);
    expect(await service.usage(100)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: 'p2',
          model: 'chat-only',
          upstreamModel: 'physical-chat',
          inboundProtocol: 'openai-responses',
          upstreamProtocol: 'openai-chat',
          routeRevision: 1,
          inputTokens: 4,
          outputTokens: 2,
        }),
      ])
    );
    expect(JSON.stringify(await service.status())).not.toContain('rotated-key');
    expect(await service.testModel('chat-only', 'claude')).toEqual({ ok: true, status: 200 });
    expect(seen.at(-1)?.model).toBe('physical-chat');
    expect(await service.route('claude-conversation')).toMatchObject({
      sourceId: catalogSourceId,
      model: 'both',
    });
    const claudeCli = process.env.EMDASH_CLAUDE_TEST_BINARY;
    if (claudeCli) {
      const selected = await service.prepareLaunch(
        catalogSourceId,
        'chat-only',
        'claude-cli',
        'claude'
      );
      const launch = buildSourceLaunch(
        'claude',
        selected.provider,
        selected.apiKey,
        'chat-only',
        [],
        selected.compatibility
      );
      if (!launch) throw new Error('Claude launch was unavailable');
      expect(launch.args.join(' ')).not.toContain(selected.apiKey);
      const home = join(dir, 'claude-cli-home');
      await mkdir(home);
      const result = promisify(execFile)(
        claudeCli,
        [
          '-p',
          '--output-format',
          'json',
          '--no-session-persistence',
          '--setting-sources',
          '',
          '--tools',
          'Read',
          ...launch.args,
          'Reply with the supplied marker.',
        ],
        {
          cwd: dir,
          timeout: 30000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: home,
            ...launch.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
        }
      );
      result.child.stdin?.end();
      expect((await result).stdout).toContain('gateway-cli-ok');
      expect(seen.at(-1)?.model).toBe('physical-chat');
      const acpHome = join(dir, 'claude-acp-home');
      await mkdir(acpHome);
      const acp = startAcpTestClient(
        resolve('../../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'),
        dir,
        {
          PATH: process.env.PATH,
          HOME: acpHome,
          CLAUDE_CONFIG_DIR: acpHome,
          CLAUDE_CODE_EXECUTABLE: claudeCli,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...launch.env,
        }
      );
      try {
        await acp.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'emdash-catalog-test', version: '1' },
        });
        const started = (await acp.call('session/new', {
          cwd: dir,
          mcpServers: [],
          _meta: {
            claudeCode: {
              options: {
                tools: ['Read'],
                settingSources: [],
                settings: { ...JSON.parse(launch.env.EMDASH_CLAUDE_SETTINGS), env: launch.env },
              },
            },
          },
        })) as {
          sessionId: string;
          models?: { availableModels: Array<{ modelId: string }> };
          configOptions?: Array<{ category?: string; options?: Array<{ value: string }> }>;
        };
        expect(
          started.models?.availableModels.map((m) => m.modelId) ??
            started.configOptions
              ?.find((option) => option.category === 'model')
              ?.options?.map((option) => option.value)
        ).toEqual(expect.arrayContaining(['both', 'chat-only']));
        expect(
          await acp.call('session/prompt', {
            sessionId: started.sessionId,
            prompt: [{ type: 'text', text: 'Reply with the supplied marker.' }],
          })
        ).toMatchObject({ stopReason: 'end_turn' });
      } finally {
        await acp.close();
      }
    }
    await service.saveModels(
      settings.models.map((m) => (m.id === 'chat-id' ? { ...m, enabled: false } : m))
    );
    const sent = seen.length;
    const disabled = await fetch(codex.provider.baseUrl + '/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${codex.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-only', input: 'hello' }),
    });
    expect(disabled.status).toBe(400);
    await disabled.text();
    expect(seen).toHaveLength(sent);
    await send(codex, 'responses');
    expect(seen.at(-1)?.model).toBe('physical-responses');
    expect(await service.routes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'codex-conversation',
          providerName: 'Provider one',
          model: 'both',
          upstreamModel: 'physical-responses',
          upstreamProtocol: 'openai-responses',
        }),
      ])
    );
    providers = providers.map((p) =>
      p.id === 'p1' ? { ...p, baseUrl: `${base}/changed-scope` } : p
    );
    await expect(
      service.prepareLaunch(catalogSourceId, 'both', 'claude-conversation', 'claude')
    ).rejects.toThrow('connection scope changed');
  } finally {
    await service.dispose();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
