import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { secret } from '@emdash/shared';
import { KeyedMutex } from '@emdash/shared/concurrency';
import type { ModelProvider } from '@core/features/model-providers/api';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import {
  gatewaySourcePrefix,
  type GatewayAccount,
  type GatewayStatus,
  type GatewayUsage,
} from '../api/contract';
import {
  catalogProvider,
  catalogSourceId,
  gatewayModelsSettingsSchema,
  upstreamProtocol,
  type GatewayModel,
  type GatewayModelsSettings,
} from '../api/model-catalog';
import type { ApiProvider } from './config';
import { apiProviders, defaultConfig, type Document } from './config';
import { gatewayHttpHeaders } from './http-headers';
import {
  catalogBindings,
  fingerprint,
  migrationPreview,
  runtimeCatalog,
  snapshotCatalog,
  taskModelCatalog,
  type CatalogSnapshot,
} from './model-catalog';
import { gatewayProviders, type ProviderCredential } from './provider-inventory';

export type GatewayRoute = {
  taskBinding?: { supplierId: string; model: string };
  catalog?: CatalogSnapshot;
  restartReason?: string;
  requiresNewSession?: boolean;
  sourceId: string;
  model: string;
  launchConfiguration?: string;
  pending?: { sourceId: string; model: string; launchConfiguration?: string };
};
type Vault = {
  version: 1;
  config: Document;
  accounts: Record<string, Document>;
  routeKey: string;
  sourceAliases?: Record<string, string>;
  providerHeaders?: Record<string, Record<string, string>>;
};
type KeyStore<T> = {
  getOrThrow(key: string): Promise<T | null>;
  setOrThrow(key: string, value: T): Promise<void>;
  getAll(): Promise<Record<string, T | undefined>>;
  clear(): Promise<void>;
  delOrThrow?(key: string): Promise<void>;
};
export type GatewayDependencies = {
  getModels?(): Promise<GatewayModelsSettings>;
  saveModels?(settings: GatewayModelsSettings): Promise<void>;
  secrets: SecretStore;
  routes: KeyStore<GatewayRoute>;
  ledger: KeyStore<GatewayUsage>;
  binary: string;
  dataDir: string;
  conversationIdle(id: string): Promise<boolean>;
  conversationLocal(id: string): Promise<boolean>;
  conversations?(): Promise<Array<{ id: string; title: string; agent: string | null }>>;
  inventory?(): Promise<ProviderCredential[]>;
  adoptLegacy?(providers: ApiProvider[]): Promise<Record<string, string>>;
};
const vaultKey = 'model-gateway:v1';
const secretError = 'Could not save gateway credentials. Secure storage must be available.';
const ledgerError = 'Usage could not be saved. Pending records remain in the gateway outbox.';
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-cpa-version': 'emdash-v1',
    'x-cpa-support-plugin': 'false',
  });
  res.end(JSON.stringify(value));
}

export class ModelGatewayService {
  private readonly taskLaunches = new KeyedMutex();
  private state: GatewayStatus['state'] = 'stopped';
  private error?: string;
  private usageError?: string;
  private usageQueue: Promise<void> = Promise.resolve();
  private replaying = false;
  private replayTimer?: ReturnType<typeof setInterval>;
  private vault?: Vault;
  private vaultQueue: Promise<unknown> = Promise.resolve();
  private child?: ChildProcess;
  private backend?: string;
  private token = randomBytes(32).toString('hex');
  private front?: Server;
  private address?: string;
  private starting?: Promise<void>;
  private accounts: GatewayAccount[] = [];
  private definitions = new Map<string, ModelProvider>();
  private providerQueue: Promise<void> = Promise.resolve();
  private providerFingerprint?: string;
  private catalogFingerprint?: string;
  private modelsQueue: Promise<void> = Promise.resolve();
  private stopping = false;
  private drain?: () => void;
  private pendingTimer?: ReturnType<typeof setInterval>;
  private pending = new Set<string>();
  private pendingCatalogs = new Set<string>();
  private switching = new Set<string>();
  private active = new Map<string, number>();
  private activeCatalogs = new Map<string, { snapshot: CatalogSnapshot; requests: number }>();
  constructor(private readonly deps: GatewayDependencies) {}

  private async load(): Promise<Vault> {
    if (!this.vault) {
      const stored = await this.deps.secrets.getSecret(vaultKey);
      this.vault = stored
        ? (JSON.parse(stored.expose()) as Vault)
        : {
            version: 1,
            config: defaultConfig(),
            accounts: {},
            routeKey: randomBytes(32).toString('hex'),
          };
      if (this.vault.version !== 1) throw new Error('Unsupported gateway configuration version.');
      if (!stored) await this.saveVault((v) => v);
    }
    return this.vault;
  }
  private async saveVault(change: (value: Vault) => Vault): Promise<void> {
    const operation = this.vaultQueue.then(async () => {
      if (!this.vault) throw new Error('Gateway is not initialized.');
      const next = change(structuredClone(this.vault));
      try {
        await this.deps.secrets.setSecret(vaultKey, secret(JSON.stringify(next), vaultKey));
      } catch {
        throw new Error(secretError);
      }
      this.vault = next;
    });
    this.vaultQueue = operation.catch(() => undefined);
    await operation;
  }
  private capability(id: string): string {
    if (!this.vault) throw new Error('Gateway is not initialized.');
    return createHmac('sha256', this.vault.routeKey).update(id).digest('hex');
  }
  private send(value: unknown): void {
    this.child?.stdin?.write(JSON.stringify(value) + '\n');
  }
  private async ingest(value: GatewayUsage): Promise<void> {
    const work = this.usageQueue.then(async () => {
      try {
        await this.deps.ledger.setOrThrow(value.id, value);
        if (this.usageError === ledgerError) this.usageError = undefined;
        this.send({ type: 'usage.ack', data: value.id });
      } catch {
        this.usageError = ledgerError;
      }
    });
    this.usageQueue = work;
    await work;
  }
  private async replay(): Promise<void> {
    if (this.replaying || this.state !== 'ready') return;
    this.replaying = true;
    try {
      for (const event of await this.control<GatewayUsage[]>('/emdash/outbox'))
        await this.ingest(event);
    } finally {
      this.replaying = false;
    }
  }
  private async control<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    if (!this.backend) throw new Error('Gateway is unavailable.');
    const response = await fetch(this.backend + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Gateway operation failed (${response.status}).`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  private canonicalSource(sourceId: string): string {
    if (sourceId === catalogSourceId) return sourceId;
    const id = sourceId.slice(gatewaySourcePrefix.length);
    return gatewaySourcePrefix + (this.vault?.sourceAliases?.[id] ?? id);
  }
  private async configuredProviders(): Promise<ApiProvider[]> {
    let vault = await this.load();
    const legacy = apiProviders(vault.config);
    if (!this.deps.inventory) return legacy;
    if (legacy.length && this.deps.adoptLegacy) {
      const aliases = await this.deps.adoptLegacy(legacy);
      await this.saveVault((v) => ({
        ...v,
        config: defaultConfig(),
        sourceAliases: { ...v.sourceAliases, ...aliases },
        providerHeaders: {
          ...v.providerHeaders,
          ...Object.fromEntries(
            legacy
              .filter((p) => Object.keys(p.headers).length)
              .map((p) => [aliases[p.id] ?? p.id, p.headers])
          ),
        },
      }));
      vault = await this.load();
    }
    const inventory = await this.deps.inventory();
    this.definitions = new Map(inventory.map(({ provider }) => [provider.id, provider]));
    const models = [
      ...((await this.deps.getModels?.())?.models ?? []),
      ...Object.values(await this.deps.routes.getAll()).flatMap((r) => r?.catalog?.models ?? []),
      ...[...this.activeCatalogs.values()].flatMap((c) => c.snapshot.models),
    ];
    // Published models need not be in the provider's discovery suggestions.
    const expanded = inventory.map((entry) => ({
      ...entry,
      provider: {
        ...entry.provider,
        models: [
          ...new Set([
            ...entry.provider.models,
            ...models.filter((m) => m.providerId === entry.provider.id).map((m) => m.alias),
          ]),
        ],
      },
    }));
    return gatewayProviders(expanded).map((p) => ({
      ...p,
      headers: vault.providerHeaders?.[p.id] ?? {},
    }));
  }
  private async syncProviders(): Promise<void> {
    const work = this.providerQueue.then(async () => {
      const providers = await this.configuredProviders();
      const published = (await this.deps.getModels?.())?.models ?? [];
      const snapshots = Object.entries(await this.deps.routes.getAll()).flatMap(([id, route]) =>
        route?.catalog
          ? [{ id: `${id}:${fingerprint(route.catalog)}`, snapshot: route.catalog }]
          : []
      );
      for (const [id, active] of this.activeCatalogs)
        if (!snapshots.some((s) => s.id === id)) snapshots.push({ id, snapshot: active.snapshot });
      const runtime = snapshots.map(({ id, snapshot }) => ({
        id,
        ...runtimeCatalog(
          {
            ...snapshot,
            models: snapshot.models.filter(
              (m) => snapshot.scope === 'task' || published.some((p) => p.id === m.id && p.enabled)
            ),
          },
          [...this.definitions.values()],
          providers
        ),
      }));
      const allProviders = [
        ...providers,
        ...new Map(runtime.flatMap((c) => c.providers).map((p) => [p.id, p])).values(),
      ];
      const nextFingerprint = fingerprint(allProviders);
      if (nextFingerprint !== this.providerFingerprint) {
        await this.control('/emdash/providers', 'PUT', allProviders);
        this.providerFingerprint = nextFingerprint;
      }
      const catalogs = runtime.map(({ id, models }) => ({ id, models }));
      const nextCatalogFingerprint = fingerprint(catalogs);
      if (nextCatalogFingerprint !== this.catalogFingerprint) {
        await this.control('/emdash/model-routes', 'PUT', catalogs);
        this.catalogFingerprint = nextCatalogFingerprint;
      }
      this.accounts = await this.control<GatewayAccount[]>('/emdash/catalog');
    });
    this.providerQueue = work.catch(() => undefined);
    await work;
  }
  private launchConfiguration(account: GatewayAccount): string {
    const definition = this.definitions.get(account.id);
    return `${account.provider}:${definition?.preferredProtocol ?? 'auto'}:${Object.keys(
      definition?.endpoints ?? {}
    )
      .sort((a, b) => a.localeCompare(b))
      .join(',')}`;
  }
  async status(): Promise<GatewayStatus> {
    if (this.state === 'ready') {
      try {
        await this.syncProviders();
      } catch {
        this.state = 'failed';
        this.error = 'Gateway connection was lost.';
      }
    }
    return {
      models: (await this.deps.getModels?.())?.models ?? [],
      accountTypes: Object.fromEntries(
        this.accounts.map((account) => [
          gatewaySourcePrefix + account.id,
          this.launchConfiguration(account),
        ])
      ),
      state: this.state,
      error: this.error,
      usageError: this.usageError,
      providers: this.accounts
        .filter(
          (a) =>
            !a.id.startsWith('model:') &&
            !a.disabled &&
            a.models.length &&
            ['emdash-responses', 'codex', 'claude'].includes(a.provider)
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map(
          (a): ModelProvider => ({
            ...this.definitions.get(a.id),
            id: gatewaySourcePrefix + a.id,
            name: a.name,
            baseUrl: '',
            ...(a.protocol === 'all'
              ? { protocol: undefined }
              : {
                  protocol:
                    a.protocol || (a.provider === 'claude' ? 'anthropic' : 'openai-responses'),
                }),
            models: a.models,
            contextWindows: a.contextWindows,
          })
        ),
    };
  }
  async restore(): Promise<void> {
    await this.ensure();
  }
  async start(): Promise<GatewayStatus> {
    await this.ensure();
    return this.status();
  }
  private async ensure(): Promise<void> {
    if (this.state === 'ready') return;
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }
  private async launch(): Promise<void> {
    if (this.child) await this.stop();
    this.state = 'starting';
    this.error = undefined;
    this.stopping = false;
    try {
      const vault = await this.load();
      if (!this.front) {
        this.front = createServer((req, res) => {
          void this.handle(req, res).catch(() =>
            json(res, 500, { error: 'Gateway request failed. Check the gateway status.' })
          );
        });
        await new Promise<void>((resolve, reject) => {
          this.front!.once('error', reject);
          this.front!.listen(0, '127.0.0.1', resolve);
        });
        const bound = this.front.address();
        if (!bound || typeof bound === 'string') throw new Error('Could not bind gateway.');
        this.address = `http://127.0.0.1:${bound.port}`;
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.deps.binary, [], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          env: Object.fromEntries(
            [
              'PATH',
              'HOME',
              'USERPROFILE',
              'TMPDIR',
              'TEMP',
              'TMP',
              'SystemRoot',
              'SYSTEMROOT',
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'NO_PROXY',
              'http_proxy',
              'https_proxy',
              'no_proxy',
              'SSL_CERT_FILE',
              'SSL_CERT_DIR',
            ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : []))
          ),
        });
        this.child = child;
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('Gateway startup timed out.'));
        }, 25000);
        const fail = (message: string): void => {
          clearTimeout(timeout);
          reject(new Error(message));
        };
        child.once('error', () =>
          fail('Gateway executable is unavailable. Build the gateway resources and retry.')
        );
        child.once('exit', () => {
          if (this.child === child) {
            this.child = undefined;
            this.backend = undefined;
            this.state = this.stopping ? 'stopped' : 'failed';
            this.error = this.stopping
              ? undefined
              : (this.error ?? 'Gateway exited. Retry to restore the connection.');
          }
          fail('Gateway exited before it was ready.');
        });
        const pipe = child.stdout;
        if (!(pipe instanceof Readable)) {
          child.kill();
          fail('Gateway control pipe is unavailable.');
          return;
        }
        const lines = createInterface({ input: pipe });
        child.once('close', () => lines.close());
        lines.on('line', (line) => {
          void (async () => {
            const msg = JSON.parse(line) as { id?: string; type: string; data: unknown };
            if (msg.type === 'ready') {
              const ready = msg.data as { protocol: number; address: string };
              if (ready.protocol !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.address))
                throw new Error('Incompatible gateway protocol.');
              this.backend = ready.address;
              this.providerFingerprint = undefined;
              this.catalogFingerprint = undefined;
              await this.syncProviders();
              const pending = await this.control<GatewayUsage[]>('/emdash/outbox');
              for (const event of pending) await this.ingest(event);
              clearTimeout(timeout);
              this.state = 'ready';
              resolve();
            } else if (msg.type === 'auth.save' || msg.type === 'auth.delete') {
              try {
                const data = msg.data as Document;
                if (typeof data.id !== 'string') throw new Error('Invalid credential.');
                const id = data.id;
                await this.saveVault((v) => {
                  if (msg.type === 'auth.save') v.accounts[id] = data;
                  else delete v.accounts[id];
                  return v;
                });
                this.send({ id: msg.id });
              } catch {
                this.send({ id: msg.id, error: secretError });
                this.error = secretError;
                child.kill();
              }
            } else if (msg.type === 'drained') {
              await this.usageQueue;
              this.drain?.();
            } else if (msg.type === 'usage') await this.ingest(msg.data as GatewayUsage);
            else if (msg.type === 'usage.error')
              this.usageError =
                'Gateway usage storage is unavailable; statistics may be incomplete.';
            else if (msg.type === 'fatal') {
              child.kill();
              fail('Gateway failed to become ready.');
            }
          })().catch(() => {
            child.kill();
            fail('Gateway initialization failed.');
          });
        });
        child.stdin?.on('error', () => undefined);
        child.stdin?.write(
          JSON.stringify({
            token: this.token,
            dataDir: this.deps.dataDir,
            accounts: Object.values(vault.accounts),
          }) + '\n'
        );
      });
      for (const [id, route] of Object.entries(await this.deps.routes.getAll())) {
        if (route?.pending) this.pending.add(id);
        if (route?.catalog) this.pendingCatalogs.add(id);
      }
      this.pendingTimer ??= setInterval(() => {
        for (const id of this.pending) void this.applyPending(id).catch(() => undefined);
        for (const id of this.pendingCatalogs)
          void this.refreshCatalogRoute(id).catch(() => undefined);
      }, 500);
      this.pendingTimer.unref();
      this.replayTimer ??= setInterval(() => {
        void this.replay().catch(() => undefined);
      }, 10000);
      this.replayTimer.unref();
    } catch (error) {
      this.state = 'failed';
      this.error = error instanceof Error ? error.message : 'Gateway could not start.';
      throw error;
    }
  }
  private async applyPending(id: string): Promise<void> {
    if (this.switching.has(id) || this.active.get(id) || !(await this.deps.conversationIdle(id)))
      return;
    this.switching.add(id);
    try {
      const route = await this.deps.routes.getOrThrow(id);
      if (route?.pending) {
        await this.deps.routes.setOrThrow(id, { ...route.pending });
        this.pending.delete(id);
      }
    } finally {
      this.switching.delete(id);
    }
  }
  async migrationPreview(): Promise<GatewayModel[]> {
    await this.load();
    await this.configuredProviders();
    return migrationPreview([...this.definitions.values()]);
  }
  async testModel(
    alias: string,
    agent: 'claude' | 'codex'
  ): Promise<{ ok: boolean; status: number }> {
    await this.prepareLaunch(catalogSourceId, alias, undefined, agent);
    const models = (await this.deps.getModels?.())?.models ?? [];
    const snapshot = snapshotCatalog(models, [...this.definitions.values()], agent);
    const id = `diagnostic:${randomBytes(16).toString('hex')}`;
    this.activeCatalogs.set(id, { snapshot, requests: 1 });
    try {
      await this.syncProviders();
      const response = await fetch(
        `${this.backend}/v1/${agent === 'claude' ? 'messages' : 'responses'}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
            'x-emdash-account': `catalog:${id}`,
            session_id: id,
          },
          body: JSON.stringify(
            agent === 'claude'
              ? { model: alias, max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }] }
              : { model: alias, max_output_tokens: 16, store: false, input: 'Reply OK.' }
          ),
          signal: AbortSignal.timeout(20000),
        }
      );
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1024 * 1024) throw new Error('The test response exceeded its size limit.');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
      }
      let valid = false;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          type?: string;
          object?: string;
        };
        valid = agent === 'claude' ? body.type === 'message' : body.object === 'response';
      } catch {
        /* A successful HTTP status alone does not validate the protocol. */
      }
      return { ok: response.ok && valid, status: response.status };
    } finally {
      this.activeCatalogs.delete(id);
    }
  }
  async saveModels(models: GatewayModel[]): Promise<void> {
    const work = this.modelsQueue.then(async () => {
      if (!this.deps.saveModels) throw new Error('Model settings are unavailable.');
      const current = (await this.deps.getModels?.())?.models ?? [];
      await this.configuredProviders();
      const next = gatewayModelsSettingsSchema.parse({ version: 1, models });
      for (const model of next.models) {
        const previous = current.find((m) => m.id === model.id);
        if (previous && previous.alias !== model.alias)
          throw new Error('Create another alias instead of renaming a published model.');
        if (previous && model.revision !== previous.revision)
          throw new Error('Model settings changed. Reload before saving.');
        const provider = this.definitions.get(model.providerId);
        if (!provider || provider.account)
          throw new Error('Select an API provider for this model.');
        // A valid model can be available to another agent even when Claude cannot use it.
        if (
          !Object.keys(model.protocolModels).every((p) =>
            provider.endpoints
              ? provider.endpoints[p as keyof NonNullable<ModelProvider['endpoints']>] !== undefined
              : !provider.protocol || provider.protocol === p
          )
        )
          throw new Error('The provider does not expose a selected model protocol.');
        model.revision = previous
          ? previous.revision + (fingerprint(model) === fingerprint(previous) ? 0 : 1)
          : 1;
      }
      await this.deps.saveModels(next);
      for (const [id, route] of Object.entries(await this.deps.routes.getAll())) {
        if (route?.catalog) {
          this.pendingCatalogs.add(id);
          await this.refreshCatalogRoute(id);
        }
      }
    });
    this.modelsQueue = work.catch(() => undefined);
    await work;
  }
  private async refreshCatalogRoute(id: string): Promise<void> {
    if (this.active.get(id) || this.switching.has(id)) return;
    this.switching.add(id);
    try {
      const route = await this.deps.routes.getOrThrow(id);
      if (!route?.catalog || route.taskBinding) {
        this.pendingCatalogs.delete(id);
        return;
      }
      const models = (await this.deps.getModels?.())?.models ?? [];
      const next = snapshotCatalog(models, [...this.definitions.values()], route.catalog.agent);
      if (fingerprint(next) === fingerprint(route.catalog) && !route.restartReason) {
        this.pendingCatalogs.delete(id);
        return;
      }
      const compatible = catalogBindings(next) === catalogBindings(route.catalog);
      if (compatible && (await this.deps.conversationIdle(id))) {
        await this.deps.routes.setOrThrow(id, {
          ...route,
          catalog: next,
          restartReason: undefined,
          requiresNewSession: undefined,
        });
        this.pendingCatalogs.delete(id);
      } else if (!compatible) {
        const binding = (snapshot: CatalogSnapshot) =>
          fingerprint(
            snapshot.models.map((model) => {
              const provider = snapshot.providers.find((p) => p.id === model.providerId);
              return {
                alias: model.alias,
                providerId: model.providerId,
                protocols: model.protocolModels,
                policy: model.protocolPolicy,
                connection: provider && {
                  protocol: provider.protocol,
                  baseUrl: provider.baseUrl,
                  endpoints: provider.endpoints,
                },
              };
            })
          );
        const requiresNewSession = binding(next) !== binding(route.catalog);
        await this.deps.routes.setOrThrow(id, {
          ...route,
          requiresNewSession,
          restartReason: requiresNewSession
            ? 'Provider or protocol binding changed. Start a new agent session to apply it safely.'
            : 'Model routes or capabilities changed. Restart to apply the saved configuration.',
        });
        this.pendingCatalogs.delete(id);
      }
    } finally {
      this.switching.delete(id);
    }
  }
  async switchRoute(input: {
    conversationId: string;
    sourceId: string;
    model: string;
  }): Promise<void> {
    await this.ensure();
    await this.syncProviders();
    const route = await this.deps.routes.getOrThrow(input.conversationId);
    if (!route) throw new Error('This conversation was not started through the gateway.');
    const sourceId = this.canonicalSource(input.sourceId);
    const account = this.accounts.find((a) => gatewaySourcePrefix + a.id === sourceId);
    if (!account || account.disabled || !account.models.includes(input.model))
      throw new Error('The account does not support this model.');
    const current = this.accounts.find(
      (a) => gatewaySourcePrefix + a.id === this.canonicalSource(route.sourceId)
    );
    if (
      !current ||
      current.protocol !== account.protocol ||
      this.launchConfiguration(current) !== this.launchConfiguration(account) ||
      (route.launchConfiguration && route.launchConfiguration !== this.launchConfiguration(account))
    )
      throw new Error('Restart to apply a different protocol or account type.');
    if (current?.contextWindows?.[route.model] !== account.contextWindows?.[input.model])
      throw new Error('Restart the conversation to apply a different context window.');
    if (input.model !== route.model)
      throw new Error(
        'Restart the conversation to apply a different model and update its capabilities.'
      );
    await this.deps.routes.setOrThrow(input.conversationId, {
      ...route,
      pending: {
        sourceId,
        model: input.model,
        ...(route.launchConfiguration && {
          launchConfiguration: this.launchConfiguration(account),
        }),
      },
    });
    this.pending.add(input.conversationId);
    await this.applyPending(input.conversationId);
  }
  async prepareTaskLaunch(
    supplierId: string,
    model: string,
    conversationId: string,
    agentId: string
  ): Promise<{ provider: ModelProvider; apiKey: string; compatibility?: boolean }> {
    return this.taskLaunches.runExclusive(conversationId, () =>
      this.prepareTaskLaunchLocked(supplierId, model, conversationId, agentId)
    );
  }
  private async prepareTaskLaunchLocked(
    supplierId: string,
    model: string,
    conversationId: string,
    agentId: string
  ): Promise<{ provider: ModelProvider; apiKey: string; compatibility?: boolean }> {
    if (!(await this.deps.conversationLocal(conversationId)))
      throw new Error('Task gateway routes support local conversations only.');
    await this.ensure();
    await this.syncProviders();
    const supplier = this.definitions.get(supplierId);
    if (!supplier) throw new Error('The selected task supplier is unavailable.');
    const saved = await this.deps.routes.getOrThrow(conversationId);
    if (
      saved &&
      (!saved.taskBinding ||
        saved.taskBinding.supplierId !== supplierId ||
        saved.taskBinding.model !== model ||
        saved.catalog?.agent !== agentId)
    ) {
      throw new Error('Start a new session to change its task supplier or model binding.');
    }
    const snapshot =
      saved?.catalog ??
      taskModelCatalog(supplier, model, agentId, (await this.deps.getModels?.())?.models ?? []);
    const diagnosticId = `task-validation:${randomBytes(16).toString('hex')}`;
    this.activeCatalogs.set(diagnosticId, { snapshot, requests: 1 });
    try {
      const runtime = runtimeCatalog(
        snapshot,
        [...this.definitions.values()],
        await this.configuredProviders()
      );
      const target = runtime.providers.find((p) => p.id === runtime.models['task-model']);
      const selected = snapshot.models[0];
      const inbound = agentId === 'claude' ? 'anthropic' : 'openai-responses';
      const protocol = selected && upstreamProtocol(selected, inbound);
      if (!target || !protocol || !(target.protocolKeys?.[protocol] || target.apiKey)) {
        throw new Error('The task supplier credentials or connection scope are unavailable.');
      }
      if (!saved)
        await this.deps.routes.setOrThrow(conversationId, {
          sourceId: catalogSourceId,
          model: 'task-model',
          catalog: snapshot,
          taskBinding: { supplierId, model },
        });
      await this.syncProviders();
      return {
        provider: {
          ...catalogProvider(snapshot.models, agentId),
          protocol: inbound,
          baseUrl: `${this.address}/sessions/${encodeURIComponent(conversationId)}${inbound === 'anthropic' ? '' : '/v1'}`,
        },
        apiKey: this.capability(conversationId),
        compatibility: agentId === 'claude' && protocol !== 'anthropic',
      };
    } finally {
      this.activeCatalogs.delete(diagnosticId);
    }
  }
  async prepareLaunch(
    sourceId: string,
    model: string | undefined,
    conversationId?: string,
    agentId?: string
  ): Promise<{ provider: ModelProvider; apiKey: string; compatibility?: boolean }> {
    if (conversationId && !(await this.deps.conversationLocal(conversationId)))
      throw new Error('The model gateway supports local conversations only.');
    await this.ensure();
    await this.syncProviders();
    if (conversationId) {
      const saved = await this.deps.routes.getOrThrow(conversationId);
      if (saved?.taskBinding) {
        return this.prepareTaskLaunch(
          saved.taskBinding.supplierId,
          saved.taskBinding.model,
          conversationId,
          agentId ?? saved.catalog?.agent ?? ''
        );
      }
    }
    if (sourceId === catalogSourceId) {
      if (!agentId) throw new Error('The gateway needs the agent protocol.');
      const models = (await this.deps.getModels?.())?.models ?? [];
      const saved = conversationId ? await this.deps.routes.getOrThrow(conversationId) : null;
      const snapshot =
        saved?.catalog ?? snapshotCatalog(models, [...this.definitions.values()], agentId);
      const provider = catalogProvider(snapshot.models, agentId);
      if (!model || !provider.models.includes(model))
        throw new Error(
          'Select an available gateway model in Settings → Providers → Gateway models.'
        );
      const selected = snapshot.models.find((m) => m.alias === model);
      if (!models.some((m) => m.id === selected?.id && m.enabled))
        throw new Error('This gateway model is disabled or unavailable.');
      const runtime = runtimeCatalog(
        snapshot,
        [...this.definitions.values()],
        await this.configuredProviders()
      );
      if (!runtime.models[model])
        throw new Error(
          'The model provider is missing credentials or its connection scope changed. Restore it or start a new session.'
        );
      const chosenProvider = runtime.providers.find((p) => p.id === runtime.models[model]);
      const targetProtocol =
        selected &&
        upstreamProtocol(selected, agentId === 'claude' ? 'anthropic' : 'openai-responses');
      if (
        !chosenProvider ||
        !targetProtocol ||
        !(chosenProvider.protocolKeys?.[targetProtocol] || chosenProvider.apiKey)
      )
        throw new Error(
          'The selected upstream protocol has no API key. Add it in Provider settings.'
        );
      if (saved?.catalog && saved.model !== model)
        throw new Error('Restart the agent to change its saved gateway model.');
      const id = conversationId ?? 'validation';
      if (conversationId) {
        await this.deps.routes.setOrThrow(id, { ...saved, sourceId, model, catalog: snapshot });
        await this.syncProviders();
      }
      const inbound = agentId === 'claude' ? 'anthropic' : 'openai-responses';
      return {
        provider: {
          ...provider,
          protocol: inbound,
          baseUrl: `${this.address}/sessions/${encodeURIComponent(id)}${inbound === 'anthropic' ? '' : '/v1'}`,
          models: [model, ...provider.models.filter((m) => m !== model)],
        },
        apiKey: this.capability(id),
        compatibility:
          agentId === 'claude' &&
          snapshot.models.some((m) => upstreamProtocol(m, 'anthropic') !== 'anthropic'),
      };
    }
    const saved = conversationId ? await this.deps.routes.getOrThrow(conversationId) : null;
    const chosen = this.canonicalSource(saved?.sourceId ?? sourceId);
    const account = this.accounts.find((a) => gatewaySourcePrefix + a.id === chosen && !a.disabled);
    if (!account || !['emdash-responses', 'codex', 'claude'].includes(account.provider))
      throw new Error('The selected gateway account is unavailable.');
    const selectedModel =
      saved?.model ?? model ?? this.definitions.get(account.id)?.models[0] ?? account.models[0];
    if (!selectedModel || !account.models.includes(selectedModel))
      throw new Error('Select a model configured on this gateway account.');
    const id = conversationId ?? 'validation';
    if (conversationId && (!saved || this.definitions.get(account.id)?.endpoints))
      await this.deps.routes.setOrThrow(id, {
        ...saved,
        sourceId: chosen,
        model: selectedModel,
        ...(this.definitions.get(account.id)?.endpoints && {
          launchConfiguration: this.launchConfiguration(account),
        }),
      });
    return {
      provider: {
        ...this.definitions.get(account.id),
        ...(this.definitions.get(account.id)?.endpoints && {
          endpoints: Object.fromEntries(
            Object.keys(this.definitions.get(account.id)!.endpoints!).map((protocol) => [
              protocol,
              `${this.address}/sessions/${encodeURIComponent(id)}${protocol === 'anthropic' ? '' : '/v1'}`,
            ])
          ),
        }),
        id: chosen,
        name: account.name,
        ...(account.protocol === 'all'
          ? { protocol: undefined }
          : {
              protocol:
                account.protocol ||
                (account.provider === 'claude' ? 'anthropic' : 'openai-responses'),
            }),
        baseUrl: `${this.address}/sessions/${encodeURIComponent(id)}${account.protocol === 'anthropic' || account.protocol === 'all' || account.provider === 'claude' ? '' : '/v1'}`,
        models: [selectedModel, ...account.models.filter((m) => m !== selectedModel)],
        contextWindows: account.contextWindows,
      },
      apiKey: this.capability(id),
    };
  }
  async route(id: string): Promise<GatewayRoute | null> {
    await this.load();
    await this.refreshCatalogRoute(id);
    const route = await this.deps.routes.getOrThrow(id);
    return route
      ? {
          ...route,
          sourceId: this.canonicalSource(route.sourceId),
          ...(route.pending && {
            pending: { ...route.pending, sourceId: this.canonicalSource(route.pending.sourceId) },
          }),
        }
      : null;
  }
  async forgetConversation(id: string): Promise<void> {
    await this.taskLaunches.runExclusive(id, async () => {
      if (!this.deps.routes.delOrThrow) throw new Error('Gateway route deletion is unavailable.');
      await this.deps.routes.delOrThrow(id);
      this.pendingCatalogs.delete(id);
      if (this.state === 'ready') await this.syncProviders();
    });
  }
  async routes() {
    await this.load();
    if (this.state === 'ready') {
      await this.syncProviders();
      for (const [id, route] of Object.entries(await this.deps.routes.getAll()))
        if (route?.catalog) await this.refreshCatalogRoute(id);
    }
    const rows = await this.deps.routes.getAll();
    const conversations = await this.deps.conversations?.();
    return Object.entries(rows).flatMap(([id, route]) => {
      if (!route) return [];
      const conversation = conversations?.find((row) => row.id === id);
      if (conversations && !conversation) return [];
      const sourceId = this.canonicalSource(route.sourceId);
      const pendingId = route.pending ? this.canonicalSource(route.pending.sourceId) : undefined;
      const binding = route.catalog?.models.find((m) => m.alias === route.model);
      const inbound = route.catalog?.agent === 'claude' ? 'anthropic' : 'openai-responses';
      const target = binding && upstreamProtocol(binding, inbound);
      return [
        {
          conversationId: id,
          title: conversation?.title || id,
          sourceId,
          providerName: binding
            ? (route.catalog?.providers.find((p) => p.id === binding.providerId)?.name ??
              binding.providerId)
            : (this.accounts.find((a) => gatewaySourcePrefix + a.id === sourceId)?.name ??
              sourceId),
          model: route.model,
          ...(route.taskBinding && { requestedModel: route.taskBinding.model }),
          ...(binding &&
            target && {
              upstreamModel: binding.protocolModels[target]?.upstreamModel,
              inboundProtocol: inbound,
              upstreamProtocol: target,
              revision: binding.revision,
            }),
          ...(route.restartReason && { restartReason: route.restartReason }),
          ...(pendingId && {
            pendingName:
              this.accounts.find((a) => gatewaySourcePrefix + a.id === pendingId)?.name ??
              pendingId,
          }),
        },
      ];
    });
  }
  async beginOAuth(provider: 'codex' | 'claude'): Promise<{ url: string; state: string }> {
    await this.ensure();
    const result = await this.control<{ url: string; state: string }>(
      `/v8/management/oauth/auth-url?provider=${provider}&is_webui=true`
    );
    const url = new URL(result.url);
    if (
      url.protocol !== 'https:' ||
      ![
        'auth.openai.com',
        'auth0.openai.com',
        'claude.ai',
        'console.anthropic.com',
        'platform.claude.com',
      ].includes(url.hostname)
    )
      throw new Error('The SDK returned an unsupported authorization URL.');
    return { url: result.url, state: result.state };
  }
  async oauthStatus(state: string): Promise<{ status: 'ok' | 'wait' | 'error'; error?: string }> {
    await this.ensure();
    const result = await this.control<{ status: 'ok' | 'wait' | 'error'; error?: string }>(
      `/v8/management/oauth/status?state=${encodeURIComponent(state)}`
    );
    if (result.status === 'ok') await this.syncProviders();
    return {
      status: result.status,
      ...(result.status === 'error'
        ? { error: 'Authorization did not complete. Start again.' }
        : {}),
    };
  }
  async completeOAuth(provider: 'codex' | 'claude', redirectUrl: string): Promise<void> {
    await this.ensure();
    await this.control('/v8/management/oauth/callback', 'POST', {
      provider,
      redirect_url: redirectUrl,
    });
  }
  async removeAccount(id: string): Promise<void> {
    await this.ensure();
    await this.control(`/emdash/credentials?name=${encodeURIComponent(id)}`, 'DELETE');
    await this.syncProviders();
  }
  async usage(limit: number): Promise<GatewayUsage[]> {
    return Object.values(await this.deps.ledger.getAll())
      .filter((v): v is GatewayUsage => Boolean(v))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pendingTimer) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = undefined;
    }
    const child = this.child;
    if (child && this.backend)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.drain = undefined;
          resolve();
        }, 2000);
        this.drain = () => {
          clearTimeout(timeout);
          this.drain = undefined;
          resolve();
        };
        this.send({ type: 'usage.drain' });
      });
    if (child)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.stdin?.end();
      });
    await this.vaultQueue;
    this.child = undefined;
    this.backend = undefined;
    this.state = 'stopped';
  }
  async dispose(): Promise<void> {
    await this.stop();
    this.front?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.front ? this.front.close(() => resolve()) : resolve()
    );
    this.front = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.address);
    const session =
      /^\/sessions\/([^/]+)(\/v1\/(responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?|models))$/.exec(
        url.pathname
      );
    if (session) {
      if (this.stopping) {
        json(res, 503, { error: 'Gateway is stopping.' });
        return;
      }
      const id = decodeURIComponent(session[1]);
      if (
        req.headers.authorization !== `Bearer ${this.capability(id)}` &&
        req.headers['x-api-key'] !== this.capability(id)
      ) {
        json(res, 401, { error: 'Invalid session credential.' });
        return;
      }
      if (!(await this.deps.conversationLocal(id))) {
        json(res, 404, { error: 'This local conversation is no longer available.' });
        return;
      }
      await this.ensure();
      await this.syncProviders();
      await this.refreshCatalogRoute(id);
      const route = await this.route(id);
      if (!route) {
        json(res, 404, { error: 'Gateway route is unavailable.' });
        return;
      }
      this.active.set(id, (this.active.get(id) ?? 0) + 1);
      const catalogId = route.catalog ? `${id}:${fingerprint(route.catalog)}` : undefined;
      if (catalogId && route.catalog) {
        const active = this.activeCatalogs.get(catalogId);
        this.activeCatalogs.set(catalogId, {
          snapshot: route.catalog,
          requests: (active?.requests ?? 0) + 1,
        });
      }
      const done = (): void => {
        this.active.set(id, Math.max(0, (this.active.get(id) ?? 1) - 1));
        if (catalogId) {
          const active = this.activeCatalogs.get(catalogId);
          if (active && active.requests > 1) active.requests--;
          else this.activeCatalogs.delete(catalogId);
        }
      };
      res.once('close', done);
      if (route.catalog) await this.syncProviders();
      this.proxy(
        req,
        res,
        session[2] + url.search,
        catalogId ? `catalog:${catalogId}` : route.sourceId.slice(gatewaySourcePrefix.length),
        id
      );
      return;
    }
    json(res, 404, { error: 'Use Providers settings to manage the local router.' });
  }

  private proxy(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    accountId?: string,
    sessionId?: string
  ): void {
    if (!this.backend) {
      json(res, 503, { error: 'Gateway is unavailable.' });
      return;
    }
    const headers: Record<string, string | string[] | undefined> = {
      ...gatewayHttpHeaders(req.headers, true),
      host: new URL(this.backend).host,
      authorization: `Bearer ${this.token}`,
      'x-emdash-account': accountId ?? '',
      session_id: sessionId ?? '',
    };
    const upstream = request(
      new URL(path, this.backend),
      { method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, {
          ...gatewayHttpHeaders(response.headers, false),
          'cache-control': 'no-store',
        });
        response.once('end', () => res.addTrailers(gatewayHttpHeaders(response.trailers, false)));
        response.once('error', () => res.destroy());
        response.pipe(res);
      }
    );
    upstream.on('error', () =>
      json(res, 502, { error: 'The gateway connection failed. The request was not replayed.' })
    );
    req.once('aborted', () => upstream.destroy());
    req.once('end', () => upstream.addTrailers(gatewayHttpHeaders(req.trailers, true)));
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  }
}
