import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { secret } from '@emdash/shared';
import { expect, it } from 'vitest';
import type { ModelProvider } from '@core/features/model-providers/api';
import { ModelGatewayService, type GatewayRoute } from './gateway-service';

function store<T>() {
  const data = new Map<string, T>();
  return {
    getOrThrow: async (key: string) => data.get(key) ?? null,
    setOrThrow: async (key: string, value: T) => {
      data.set(key, structuredClone(value));
    },
    getAll: async () => Object.fromEntries(data),
    delOrThrow: async (id: string) => {
      data.delete(id);
    },
    clear: async () => {
      data.clear();
    },
  };
}

it('keeps supplier/model bindings private across catalog changes and routes real gateway requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'emdash-task-routes-'));
  const seen: Array<{ model: string; key?: string; effort?: string }> = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({
        model: body.model,
        key: req.headers.authorization,
        effort: body.reasoning?.effort,
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'response',
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [],
          usage: { input_tokens: 2, output_tokens: 1 },
        })
      );
    })().catch(() => res.destroy());
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  let providers: ModelProvider[] = ['one', 'two'].map((id) => ({
    id,
    name: id,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    protocol: 'openai-responses',
    models: [],
  }));
  const routes = store<GatewayRoute>();
  const vault = new Map<string, string>();
  const gateway = new ModelGatewayService({
    binary: resolve(
      `../model-gateway/dist/${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}/model-gateway${process.platform === 'win32' ? '.exe' : ''}`
    ),
    dataDir: directory,
    routes,
    ledger: store(),
    getModels: async () => ({ version: 1, models: [] }),
    saveModels: async () => {},
    inventory: async () =>
      providers.map((provider) => ({ provider, apiKey: `fake-${provider.id}` })),
    conversationIdle: async () => true,
    conversationLocal: async () => true,
    secrets: {
      getSecret: async (key) => (vault.has(key) ? secret(vault.get(key)!, key) : null),
      setSecret: async (key, value) => {
        vault.set(key, value.expose());
      },
      deleteSecret: async (key) => {
        vault.delete(key);
      },
    },
  });
  try {
    const first = await gateway.prepareTaskLaunch('one', 'custom-a', 'a', 'codex');
    const second = await gateway.prepareTaskLaunch('two', 'custom-b', 'b', 'codex');
    const request = async (launch: typeof first) => {
      const response = await fetch(`${launch.provider.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${launch.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'task-model', input: 'hello', reasoning: { effort: 'low' } }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
    };
    await request(first);
    await request(second);
    expect(seen).toEqual([
      { model: 'custom-a', key: 'Bearer fake-one', effort: 'low' },
      { model: 'custom-b', key: 'Bearer fake-two', effort: 'low' },
    ]);
    await gateway.saveModels([]);
    expect((await gateway.route('a'))?.taskBinding).toEqual({
      supplierId: 'one',
      model: 'custom-a',
    });
    await gateway.prepareLaunch('gateway:models', 'custom-a', 'a', 'codex');
    await expect(gateway.prepareTaskLaunch('two', 'custom-b', 'a', 'codex')).rejects.toThrow(
      'new session'
    );
    providers = providers.filter((provider) => provider.id !== 'one');
    await expect(gateway.prepareTaskLaunch('one', 'custom-a', 'a', 'codex')).rejects.toThrow(
      'unavailable'
    );
    expect((await routes.getOrThrow('b'))?.taskBinding?.supplierId).toBe('two');
    await gateway.forgetConversation('a');
    expect(await routes.getOrThrow('a')).toBeNull();
    expect((await routes.getOrThrow('b'))?.taskBinding?.supplierId).toBe('two');
  } finally {
    await gateway.dispose();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
