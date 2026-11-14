import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { secret } from '@emdash/shared';
import { expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import type { GatewayUsage } from '../api/contract';
import { apiProviders } from './config';
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
const binary = resolve(
  `../model-gateway/dist/${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}/model-gateway${process.platform === 'win32' ? '.exe' : ''}`
);
const built = await access(binary).then(
  () => true,
  () => false
);

it.runIf(built)(
  'routes a single provider to distinct protocol URLs with shared and overridden keys',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-multi-protocol-'));
    const seen: Array<{ path: string; key?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url!, key: req.headers.authorization });
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"usage":{"input_tokens":1,"output_tokens":2}}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const upstream = `http://127.0.0.1:${address.port}`;
    const provider: ModelProvider = {
      id: 'multi',
      name: 'One provider',
      baseUrl: upstream + '/chat/v1',
      models: ['m'],
      endpoints: {
        anthropic: upstream + '/anthropic',
        'openai-chat': '',
        'openai-responses': upstream + '/responses/v1',
      },
    };
    let apiKey: string | null = 'fake-shared';
    const protocolKeys: Partial<Record<'anthropic' | 'openai-chat' | 'openai-responses', string>> =
      { 'openai-chat': 'fake-chat' };
    const vault = new Map<string, string>();
    const service = new ModelGatewayService({
      binary,
      dataDir: dir,
      routes: store<GatewayRoute>(),
      ledger: store<GatewayUsage>(),
      inventory: async () => [{ provider, apiKey, protocolKeys }],
      secrets: {
        getSecret: async (key) => (vault.has(key) ? secret(vault.get(key)!, key) : null),
        setSecret: async (key, value) => {
          vault.set(key, value.expose());
        },
        deleteSecret: async (key) => {
          vault.delete(key);
        },
      },
      conversationIdle: async () => true,
      conversationLocal: async () => true,
    });
    try {
      await service.restore();
      expect((await service.status()).providers).toHaveLength(1);
      const target = await service.prepareLaunch('gateway:multi', 'm', 'one-conversation');
      expect(JSON.stringify(target.provider)).not.toContain(upstream);
      const base = target.provider.endpoints!.anthropic!;
      const ask = async (path: string) =>
        fetch(base + '/v1/' + path, {
          method: 'POST',
          headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'm', messages: [], input: 'test' }),
        });
      for (const path of ['responses', 'chat/completions', 'messages'])
        expect((await ask(path)).status).toBe(200);
      expect(seen).toEqual([
        { path: '/responses/v1/responses', key: 'Bearer fake-shared' },
        { path: '/chat/v1/chat/completions', key: 'Bearer fake-chat' },
        { path: '/anthropic/v1/messages', key: 'Bearer fake-shared' },
      ]);
      // Updating protocol keys applies to the existing conversation, without restarting it.
      apiKey = null;
      protocolKeys.anthropic = 'fake-messages';
      protocolKeys['openai-responses'] = 'fake-responses';
      expect((await service.status()).state).toBe('ready');
      for (const path of ['responses', 'chat/completions', 'messages'])
        expect((await ask(path)).status).toBe(200);
      expect(seen.slice(3).map((row) => row.key)).toEqual([
        'Bearer fake-responses',
        'Bearer fake-chat',
        'Bearer fake-messages',
      ]);
      provider.preferredProtocol = 'openai-responses';
      await service.status();
      await expect(
        service.switchRoute({
          conversationId: 'one-conversation',
          sourceId: 'gateway:multi',
          model: 'm',
        })
      ).rejects.toThrow('Restart');
      delete protocolKeys['openai-chat'];
      await service.status();
      expect((await ask('chat/completions')).status).toBe(401);
      expect(seen).toHaveLength(6);
      delete provider.endpoints!['openai-chat'];
      await service.status();
      expect((await ask('chat/completions')).status).toBe(400);
      expect(seen).toHaveLength(6);
    } finally {
      await service.dispose();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000
);

it.runIf(built)(
  'routes all three protocols from one live Providers inventory and retains independent usage',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-unified-gateway-'));
    const seen: Array<{
      path: string;
      payload: Record<string, unknown>;
      authorization?: string;
      key?: string;
    }> = [];
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const part of req) chunks.push(Buffer.from(part));
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        seen.push({
          path: req.url!,
          payload,
          authorization: req.headers.authorization,
          key: req.headers['x-api-key'] as string | undefined,
        });
        if (req.url?.endsWith('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"input_tokens":9}');
          return;
        }
        if (!payload.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'reply',
              choices: [],
              content: [],
              usage: { input_tokens: 9, output_tokens: 4, prompt_tokens: 9, completion_tokens: 4 },
            })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (req.url?.endsWith('/messages'))
          res.end(
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"cache_read_input_tokens":2}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
          );
        else if (req.url?.endsWith('/chat/completions'))
          res.end(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool","function":{"name":"read","arguments":"{}"}}]}}],"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}\n\ndata: [DONE]\n\n'
          );
        else
          res.end(
            'event: response.completed\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":9,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}}}\n\n'
          );
      })().catch(() => res.destroy());
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const root = `http://127.0.0.1:${address.port}`;
    let providers: ModelProvider[] = [
      {
        id: 'responses',
        name: 'Responses API',
        protocol: 'openai-responses',
        baseUrl: root + '/v1',
        models: ['public'],
        modelAliases: { public: 'upstream' },
      },
      {
        id: 'chat',
        name: 'Chat API',
        protocol: 'openai-chat',
        baseUrl: root + '/v1',
        models: ['public'],
        modelAliases: { public: 'upstream' },
      },
      {
        id: 'messages',
        name: 'Messages API',
        protocol: 'anthropic',
        baseUrl: root,
        models: ['public'],
        modelAliases: { public: 'upstream' },
      },
    ];
    const vault = new Map<string, string>();
    const service = new ModelGatewayService({
      binary,
      dataDir: dir,
      routes: store<GatewayRoute>(),
      ledger: store<GatewayUsage>(),
      secrets: {
        getSecret: async (key) => (vault.has(key) ? secret(vault.get(key)!, key) : null),
        setSecret: async (key, value) => {
          vault.set(key, value.expose());
        },
        deleteSecret: async (key) => {
          vault.delete(key);
        },
      },
      inventory: async () =>
        providers.map((provider) => ({ provider, apiKey: `fake-${provider.id}` })),
      conversationIdle: async () => true,
      conversationLocal: async () => true,
      conversations: async () =>
        providers.map((p) => ({
          id: p.id,
          title: `${p.name} conversation`,
          agent: p.id === 'messages' ? 'claude' : 'codex',
        })),
    });
    try {
      await service.restore();
      const status = await service.status();
      expect(status.state).toBe('ready');
      expect(
        status.providers.map((p) => p.protocol).sort((a, b) => (a ?? '').localeCompare(b ?? ''))
      ).toEqual(['anthropic', 'openai-chat', 'openai-responses']);
      expect(JSON.stringify(status)).not.toContain('fake-');
      const targets = [];
      for (const provider of providers) {
        const target = await service.prepareLaunch(`gateway:${provider.id}`, 'public', provider.id);
        targets.push(target);
        const path =
          provider.protocol === 'anthropic'
            ? '/v1/messages'
            : provider.protocol === 'openai-chat'
              ? '/chat/completions'
              : '/responses';
        for (const stream of [false, true]) {
          const response = await fetch(target.provider.baseUrl + path, {
            method: 'POST',
            headers:
              provider.protocol === 'anthropic'
                ? { 'x-api-key': target.apiKey, 'content-type': 'application/json' }
                : { Authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'public',
              stream,
              messages: [{ role: 'user', content: 'keep context' }],
              tools: [{ type: 'function', function: { name: 'read' } }],
            }),
          });
          expect(response.status, await response.text()).toBe(200);
        }
      }
      expect(seen).toHaveLength(6);
      expect(seen.every((r) => r.payload.model === 'upstream')).toBe(true);
      expect(seen.every((r) => r.authorization?.startsWith('Bearer fake-'))).toBe(true);
      expect((await service.routes()).map((r) => r.providerName).sort()).toEqual([
        'Chat API',
        'Messages API',
        'Responses API',
      ]);
      const count = await fetch(targets[2].provider.baseUrl + '/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'x-api-key': targets[2].apiKey },
        body: JSON.stringify({ model: 'public', messages: [] }),
      });
      expect(await count.json()).toEqual({ input_tokens: 9 });
      await service.stop();
      await service.restore();
      expect(await service.usage(100)).toHaveLength(6);
      expect(
        (await service.usage(100)).every(
          (r) => r.inputTokens === 9 && r.outputTokens === 4 && r.status === 'complete'
        )
      ).toBe(true);
      providers = providers.filter((p) => p.id !== 'chat');
      await service.status();
      const removed = await fetch(targets[1].provider.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${targets[1].apiKey}` },
        body: JSON.stringify({ model: 'public', stream: true }),
      });
      expect(removed.status).toBeGreaterThanOrEqual(400);
      expect(seen).toHaveLength(7);
    } finally {
      await service.dispose();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000
);

it.runIf(built)(
  'adopts the retired gateway inventory once and preserves saved conversation bindings',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emdash-gateway-adopt-'));
    const config = {
      'api-keys': {
        codex: [
          {
            name: 'Imported provider',
            'base-url': 'https://example.test/v1',
            keys: [
              {
                'api-key': 'fake-import-key',
                models: [{ name: 'upstream', alias: 'public' }],
                headers: { 'x-private': 'fake-header' },
              },
            ],
          },
        ],
      },
    };
    const legacy = apiProviders(config)[0];
    const vault = new Map<string, string>([
      [
        'model-gateway:v1',
        JSON.stringify({ version: 1, config, accounts: {}, routeKey: 'stable-test-signing-key' }),
      ],
    ]);
    const routes = store<GatewayRoute>();
    await routes.setOrThrow('conversation', { sourceId: `gateway:${legacy.id}`, model: 'public' });
    let inventory: Array<{ provider: ModelProvider; apiKey: string }> = [];
    let adopted = 0;
    const service = new ModelGatewayService({
      binary,
      dataDir: dir,
      routes,
      ledger: store<GatewayUsage>(),
      secrets: {
        getSecret: async (key) => (vault.has(key) ? secret(vault.get(key)!, key) : null),
        setSecret: async (key, value) => {
          vault.set(key, value.expose());
        },
        deleteSecret: async (key) => {
          vault.delete(key);
        },
      },
      inventory: async () => inventory,
      adoptLegacy: async (entries) => {
        adopted++;
        expect(entries[0].apiKey).toBe('fake-import-key');
        inventory = [
          {
            provider: {
              id: 'canonical',
              name: entries[0].name,
              protocol: 'openai-responses',
              baseUrl: entries[0].baseUrl,
              models: entries[0].models,
              modelAliases: entries[0].modelMap,
            },
            apiKey: entries[0].apiKey,
          },
        ];
        return { [legacy.id]: 'canonical' };
      },
      conversationIdle: async () => true,
      conversationLocal: async () => true,
    });
    try {
      await service.restore();
      expect((await service.status()).providers.map((p) => p.id)).toEqual(['gateway:canonical']);
      expect((await service.route('conversation'))?.sourceId).toBe('gateway:canonical');
      expect(
        (await service.prepareLaunch(`gateway:${legacy.id}`, 'public', 'conversation')).provider.id
      ).toBe('gateway:canonical');
      const persisted = JSON.parse(vault.get('model-gateway:v1')!);
      expect(apiProviders(persisted.config)).toEqual([]);
      expect(persisted.providerHeaders.canonical['x-private']).toBe('fake-header');
      expect(JSON.stringify((await service.status()).providers)).not.toContain('fake-');
      await service.stop();
      await service.restore();
      expect(adopted).toBe(1);
      expect((await service.route('conversation'))?.sourceId).toBe('gateway:canonical');
    } finally {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000
);
