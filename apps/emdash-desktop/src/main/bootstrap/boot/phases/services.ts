import { randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  hostRef,
  isLocalHostRef,
  LOCAL_HOST_REF,
  type HostRef,
} from '@emdash/core/primitives/host/api';
import { integrationPluginRegistry } from '@emdash/plugins/integrations';
import { pullRequestsPluginRegistry } from '@emdash/plugins/pull-requests';
import { err, ok, secret } from '@emdash/shared';
import { runWithTimeout } from '@emdash/shared/scheduling';
import { peek } from '@emdash/wire/state';
import { app, Notification, powerMonitor } from 'electron';
import { AccountAuthServerClient } from '@core/features/account/node/services/account-auth-server-client';
import { AccountOAuthClient } from '@core/features/account/node/services/account-oauth-client';
import type { AccountKVSchema } from '@core/features/account/node/services/account-session-store';
import { AccountCredentialStore } from '@core/features/account/node/services/credential-store';
import { createEmdashAccountService } from '@core/features/account/node/services/emdash-account-service';
import { ProviderTokenDispatcher } from '@core/features/account/node/services/provider-token-dispatcher';
import type { AgentControlDispatcher } from '@core/features/agent-control/node/agent-control-dispatcher';
import { createAgentControlDispatcher } from '@core/features/agent-control/node/agent-control-dispatcher';
import { startAgentControlServer } from '@core/features/agent-control/node/agent-control-server';
import { agentControlEvents } from '@core/features/agent-control/node/event-host';
import { resolveAgentCaller } from '@core/features/agent-control/node/resolve-caller';
import type { LaunchMcpServer } from '@core/features/agent-library/api';
import {
  createAgentLibraryService,
  listLocalWorkspaces,
  type AgentLibraryService,
} from '@core/features/agent-library/node/agent-library-service';
import {
  pruneCursorPluginDirs,
  writeCursorPluginDir,
} from '@core/features/agent-library/node/cursor-plugin';
import {
  acpMcpServers,
  launchableMcpServers,
  terminalLaunchForMcp,
} from '@core/features/agent-library/node/mcp-launch';
import { SKILL_LIBRARY_DIRNAME } from '@core/features/agent-library/node/skill-library';
import { getPluginMetadata } from '@core/features/agents/api/node/plugin-registry';
import { AutomationsService } from '@core/features/automations/api/node/automations-service';
import { buildAutomationDeployment } from '@core/features/automations/node/deployment-builder';
import { resumeLegacyCursorConversation } from '@core/features/conversations/node/legacy-cursor-sessions';
import { getProviderSettingsService } from '@core/features/conversations/node/provider-settings-service';
import {
  createPriceCatalog,
  type PriceCatalog,
} from '@core/features/conversations/node/session-cost';
import { createConversationDeletionSweepKind } from '@core/features/conversations/node/sweep/conversation-deletion-sweep';
import { ConversationBackfillService } from '@core/features/conversations/node/sync/conversation-backfill';
import { ConversationSyncService } from '@core/features/conversations/node/sync/conversation-sync-service';
import { TuiConversationProvider } from '@core/features/conversations/node/tui-conversation-provider';
import { createUsageScanner } from '@core/features/conversations/node/usage-stats/session-records';
import {
  readUsageAttribution,
  createOpenCodeCallReader,
  usageSessionRoots,
} from '@core/features/conversations/node/usage-stats/usage-attribution';
import { createUsageStatsService } from '@core/features/conversations/node/usage-stats/usage-stats-service';
import {
  createGitCredentialsService,
  type GitCredentialsService,
} from '@core/features/github/api/node/services/git-credentials-service';
import { createGitHubCredentialReader } from '@core/features/github/api/node/services/github-credentials';
import { GitHubCliAccountImportService } from '@core/features/github/node/accounts/github-cli-account-import';
import { GitHubLegacyTokenImportStep } from '@core/features/github/node/accounts/github-legacy-token-import-step';
import { GitCredentialServer } from '@core/features/github/node/services/git-credential-server';
import { githubIdentityClient } from '@core/features/github/node/services/github-identity-client';
import { LegacyGitHubTokenMigrationStore } from '@core/features/github/node/services/legacy-github-token-migration-store';
import { clearOctokitCache } from '@core/features/github/node/services/octokit-cache';
import { createGitHubRepositoryService } from '@core/features/github/node/services/repo-service';
import { createIntegrationCredentialReader } from '@core/features/integrations/api/node/integration-credential-reader';
import { createProjectIntegrationAccountResolver } from '@core/features/integrations/api/node/project-integration-account-resolver';
import { integrationsEvents } from '@core/features/integrations/node/event-host';
import { IntegrationAccountStore } from '@core/features/integrations/node/integration-account-store';
import { setIntegrationAccountStore } from '@core/features/integrations/node/integration-account-store-instance';
import {
  IntegrationConnectionService,
  setIntegrationConnectionService,
} from '@core/features/integrations/node/integration-connection-service';
import {
  IntegrationDeviceFlowService,
  setIntegrationDeviceFlowService,
} from '@core/features/integrations/node/integration-device-flow-service';
import {
  createEmdashOAuthRenewer,
  EMDASH_OAUTH_CREDENTIAL_SOURCE,
  IntegrationOAuthTokens,
} from '@core/features/integrations/node/integration-oauth-tokens';
import { migrateGitHubJsonCredentials } from '@core/features/integrations/node/migrations/github-json-credentials';
import { LegacyIntegrationAccountsMigration } from '@core/features/integrations/node/migrations/legacy-integration-accounts';
import { createIssueProviderRegistry } from '@core/features/issues/node/registry';
import {
  createPromptLibraryService,
  type PromptLibraryKV,
} from '@core/features/library/node/prompt-library-service';
import { LocalSettingsSync } from '@core/features/machines/node/local-settings-sync';
import {
  isOfficialAccount,
  type ModelProviderKeys,
  type ModelSourceOverride,
  type UsageLimitsService,
} from '@core/features/model-providers/api';
import { prepareAgentProvider } from '@core/features/model-providers/node/agent-provider-files';
import {
  ensureCodexModelCatalog,
  readKnownCodexModels,
} from '@core/features/model-providers/node/codex-model-catalog';
import {
  createEffectiveAgentConfig,
  type EffectiveAgentConfig,
} from '@core/features/model-providers/node/effective-agent-config';
import {
  mainAgentHome,
  prepareAccountHome,
} from '@core/features/model-providers/node/official-accounts';
import { createModelProviderKeys } from '@core/features/model-providers/node/provider-keys';
import { createUsageLimitsService } from '@core/features/model-providers/node/usage-limits';
import { previewServerService } from '@core/features/preview-servers/api/node/preview-server-service-instance';
import { PreviewServerAccessService } from '@core/features/preview-servers/node/preview-server-access-service';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import { projectEvents } from '@core/features/projects/api/node/project-events';
import {
  loadStoredGitSettings,
  loadStoredIntegrationAccounts,
} from '@core/features/projects/api/node/settings/effective-settings';
import { ProjectSettingsService } from '@core/features/projects/api/node/settings/project-settings-service';
import type { ProjectDeletionDependencies } from '@core/features/projects/node/operations/deleteProject';
import {
  getProjectById,
  getProjectByPath,
} from '@core/features/projects/node/operations/getProjects';
import { createProjectAttachmentAdapter } from '@core/features/projects/node/project-attachment-adapter';
import { createProjectAttachmentManager } from '@core/features/projects/node/project-attachment-manager';
import { migrateAppWorktreeRootToLocalHostDefault } from '@core/features/projects/node/settings/migrations/app-worktree-root';
import type { RemoteAccessService, RemoteClientService } from '@core/features/remote-access/api';
import { createRemoteAccessAuth } from '@core/features/remote-access/node/remote-access-auth';
import { createRemoteAccessService } from '@core/features/remote-access/node/remote-access-service';
import {
  pullRequestRepositoryUrls,
  resolvePullRequestAccount,
  resolvePullRequestIntegration,
} from '@core/features/repository/api/node/pull-request-routing';
import { repositoryRouter } from '@core/features/repository/api/node/repository-router';
import { createGitLabRepositoryService } from '@core/features/repository/node/gitlab-repository-service';
import type { ProjectRequirements } from '@core/features/requirements/api/types';
import { requirementsEvents } from '@core/features/requirements/node/event-host';
import { RequirementsService } from '@core/features/requirements/node/requirements-service';
import { createSearchService } from '@core/features/search/node/search-service';
import { TaskService } from '@core/features/tasks/api/node/task-service';
import type { TaskSessionCleanup } from '@core/features/tasks/api/node/task-session-cleanup';
import { TaskSessionLaunchContextResolver } from '@core/features/tasks/api/node/task-session-launch-context';
import { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import { installAutomationTelemetry } from '@core/features/telemetry/node/automation-telemetry';
import { installTaskTelemetry } from '@core/features/telemetry/node/task-telemetry';
import { createUsageOverview } from '@core/features/usage/node/usage-overview';
import { desktopHostEvents } from '@core/features/workbench/node/event-host';
import {
  createWorkspaceLifecycleParticipants,
  deactivateWorkspaceParticipants,
} from '@core/features/workspaces/api/node/lifecycle-participants';
import { WorkspacePlacementResolver } from '@core/features/workspaces/api/node/placement/workspace-placement-resolver';
import { WorkspaceCreations } from '@core/features/workspaces/api/node/registry-verbs';
import { acquireWorkspaceRuntime } from '@core/features/workspaces/api/node/runtime-access';
import type { TaskProviderOpts } from '@core/features/workspaces/api/node/workspace-factory';
import { createWorkspaceDeletionSweepKind } from '@core/features/workspaces/node/sweep/workspace-deletion-sweep';
import { WorkspaceRegistryBackfillService } from '@core/features/workspaces/node/sync/workspace-registry-backfill';
import { WorkspaceRegistrySyncService } from '@core/features/workspaces/node/sync/workspace-registry-sync-service';
import { startPeriodicSweep } from '@core/primitives/periodic-sweep/node/periodic-sweep';
import { DEFAULT_AGENT_GIT_CREDENTIALS } from '@core/primitives/project-settings/api';
import type { HostReachabilityProbe } from '@core/primitives/ssh/api';
import { AppDbKeyValueStore } from '@core/services/app-db/node/key-value-store';
import { createNotificationService } from '@core/services/notifications/node';
import { LegacyAccountImports } from '@core/services/provider-accounts/node/migrations/legacy-account-imports';
import { listProviderAccountSummaries } from '@core/services/provider-accounts/node/provider-account-service';
import {
  ProviderAccountService,
  setProviderAccountService,
} from '@core/services/provider-accounts/node/provider-account-service';
import { PullRequestsRegistration } from '@core/services/pull-requests/node/pull-requests-registration';
import {
  bindPullRequestIntegrationResolver,
  bindPullRequestSyncIdentityResolver,
} from '@core/services/pull-requests/node/sync-identity';
import { ReconcileSweepService } from '@core/services/reconcile-sweep/node/reconcile-sweep-service';
import {
  createReconcileSweepTriggers,
  installReconcileSweepTriggers,
} from '@core/services/reconcile-sweep/node/reconcile-sweep-triggers';
import type { AppSettingsKey } from '@core/services/settings/api';
import { createProviderOverrideSettings } from '@core/services/settings/node/provider-settings-service';
import { createHostReachabilityProbe } from '@core/services/ssh/node/host-reachability';
import { agentStatusService } from '@main/core/agent-status/agent-status-service';
import { appService } from '@main/core/app/service';
import {
  createFileSearchRuntime,
  searchFileSearchRoot,
} from '@main/core/file-search/runtime-client';
import { GitRepositoryFetchService } from '@main/core/git/repository/fetch-service';
import { GitRepositoryService } from '@main/core/git/repository/service';
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { ensureAbsoluteDir } from '@main/core/runtime/files-helpers';
import {
  killLifecycleAcpSessions,
  killLifecycleTerminalSessions,
  resolveLifecycleSessionTargets,
  type SessionCleanupDependencies,
} from '@main/core/runtime/operations/session-cleanup';
import { sweepSessionHygiene } from '@main/core/runtime/operations/session-hygiene';
import { createDesktopSessionIntentStores } from '@main/core/runtime/session-intent-stores';
import { executeOAuthFlow } from '@main/core/shared/oauth-flow';
import { getTerminalColorEnv } from '@main/core/terminal-shell/color-env';
import { runLocalCommand } from '@main/core/utils/exec';
import { desktopKeyValueStore } from '@main/db/kv';
import { cleanupLegacyOperationsDatabases } from '@main/db/legacy-operations-cleanup';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { openRemoteWireSession, setRemoteRouting } from '@main/gateway/desktop-wire';
import { createDesktopWorkspaceRuntimeAcquirer } from '@main/gateway/workspace-runtime';
import { setBrowserCorsRelaxationSettings } from '@main/host/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/host/browser/browser-webcontents-registry';
import { HostAttachmentRegistry } from '@main/host/host-attachment-registry';
import { createSystemNotificationSink } from '@main/host/notifications/system-notification-sink';
import { createRemoteAccessServer } from '@main/host/remote-access-server';
import { setRemoteBrowserProxyPort } from '@main/host/remote-client/browser-proxy';
import { createRemoteClientService } from '@main/host/remote-client/remote-client-service';
import { launchAppWindow, takeWindowServer } from '@main/host/remote-client/window-launcher';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { toPlaintextSecretStore } from '@main/host/secrets/plaintext-secret-store';
import { setTrayVisible } from '@main/host/tray';
import { installUpdateNotifications } from '@main/host/updates/update-notifications';
import { getMainWindow } from '@main/host/window';
import { applyNativeTheme, isAppFocused, setWindowComputer } from '@main/host/window';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { appScope } from '../../core/app-scope';
import { runInBackground } from '../../core/background';
import { step } from '../../core/phase';
import { setCoreServiceInstances } from '../../core/service-instances';
import { wireAccountTelemetry } from '../wiring';
import type { DatabaseBundle } from './database';
import type { InfrastructureBundle } from './infrastructure';

export type ServicesBundle = {
  readonly account: ReturnType<typeof createEmdashAccountService>;
  readonly automations: AutomationsService;
  readonly github: {
    cliImport: GitHubCliAccountImportService;
    legacyTokenImport: GitHubLegacyTokenImportStep;
    repositories: ReturnType<typeof createGitHubRepositoryService>;
  };
  readonly gitlabRepositories: ReturnType<typeof createGitLabRepositoryService>;
  readonly gitCredentials: GitCredentialsService;
  readonly issueProviders: ReturnType<typeof createIssueProviderRegistry>;
  readonly hostIsReachable: HostReachabilityProbe;
  readonly hostAttachments: HostAttachmentRegistry;
  readonly notifications: ReturnType<typeof createNotificationService>;
  readonly previewServerAccess: PreviewServerAccessService;
  readonly promptLibrary: ReturnType<typeof createPromptLibraryService>;
  readonly requirements: RequirementsService;
  readonly projectDeletion: ProjectDeletionDependencies;
  readonly projects: ProjectAttachmentManager;
  readonly projectSettings: ProjectSettingsService;
  readonly providerSettings: ReturnType<typeof createProviderOverrideSettings>;
  /** Agent config for a launch, including its model provider source (both UIs). */
  readonly effectiveAgentConfig: EffectiveAgentConfig;
  /** API list prices of models, for conversations' equivalent cost. */
  readonly priceCatalog: () => Promise<PriceCatalog>;
  readonly modelProviderKeys: ModelProviderKeys;
  readonly usageLimits: UsageLimitsService;
  readonly agentControl: AgentControlDispatcher;
  /** Emdash's own MCP URL for a local conversation's agent; null if unavailable. */
  readonly agentLibrary: AgentLibraryService;
  /** Readies a local chat agent's workspace and returns the MCP servers Emdash adds. */
  readonly prepareAgentLaunch: (input: {
    conversationId: string;
    projectId: string;
    workspacePath: string;
  }) => Promise<ReturnType<typeof acpMcpServers>>;
  readonly remoteAccess: RemoteAccessService;
  readonly remoteClient: RemoteClientService;
  readonly pullRequestsRegistration: PullRequestsRegistration;
  readonly search: ReturnType<typeof createSearchService>;
  readonly sessionLaunchContexts: TaskSessionLaunchContextResolver;
  readonly taskService: TaskService;
  readonly taskSessions: TaskSessionManager;
  readonly usage: ReturnType<typeof createUsageOverview>;
  readonly usageStats: ReturnType<typeof createUsageStatsService>;
  readonly workspacePlacement: WorkspacePlacementResolver;
  readonly conversationSync: ConversationSyncService;
  readonly reconcileSweep: ReconcileSweepService;
};

export async function bootServices(
  database: DatabaseBundle,
  infrastructure: InfrastructureBundle,
  desktopRuntimes: DesktopRuntimes
): Promise<ServicesBundle> {
  const { appSettings: appSettingsService, db, sqlite, workspaceIdentity } = database;
  const { clients, broker: runtimes } = desktopRuntimes;
  const usage = createUsageOverview({
    scope: appScope,
    runtimes,
    machines: infrastructure.ssh.machines,
    hosts: infrastructure.hosts,
    hostAvailability: desktopRuntimes.hostAvailability,
  });
  const getMementosRuntimeClient = async () => clients.mementos;
  const getPullRequestsRuntimeClient = async () => clients.pullRequests;
  const getTerminalsRuntimeClient = async () => clients.terminals;
  const getTuiAgentsRuntimeClient = async () => clients.tuiAgents;
  previewServerService.attachSshRuntime({
    getConnectionState: (connectionId) =>
      infrastructure.ssh.manager.getConnectionState(connectionId),
    getSshProxy: async (connectionId) => {
      await infrastructure.ssh.ssh.ensureConnected(connectionId);
      const proxy = infrastructure.ssh.manager.getProxy(connectionId);
      if (!proxy) throw new Error(`SSH connection ${connectionId} is not available`);
      return proxy;
    },
    inspectRemotePort: async (connectionId, remotePort) => {
      // Advisory only: rejections here mean "no hint" to the tunnel, which
      // then keeps its blind dual-family dial. The usability guard keeps the
      // probe from triggering workspace-server provisioning as a side effect.
      if (peek(infrastructure.hosts.availability(connectionId)).kind !== 'ready') {
        throw new Error(`No usable workspace server for SSH connection ${connectionId}`);
      }
      const host = infrastructure.hosts.get(hostRef('remote', connectionId));
      if (!host) throw new Error(`Host '${connectionId}' is not managed`);
      const connection = await host.runtime.client();
      const inspected = await runWithTimeout(
        () => connection.client.portForwards.inspect({ port: remotePort }),
        { timeoutMs: 2_000 }
      );
      if (!inspected.success) throw new Error(inspected.error.message);
      return inspected.data;
    },
  });
  const handleSshConnectionEvent = (
    event: Parameters<typeof previewServerService.handleSshConnectionEvent>[0]
  ) => {
    previewServerService.handleSshConnectionEvent(event);
  };
  infrastructure.ssh.manager.on('connection-event', handleSshConnectionEvent);
  appScope.add(() => {
    infrastructure.ssh.manager.off('connection-event', handleSshConnectionEvent);
  });
  const fileSearchRuntime = createFileSearchRuntime(runtimes, {
    getSearchExclusions: async () => (await appSettingsService.get('files')).searchExclude,
  });
  const handleFileSearchSettingsChanged = (key: AppSettingsKey) => {
    if (key === 'files') void fileSearchRuntime.refreshExclusions();
  };
  appSettingsService.on('app-settings:changed', handleFileSearchSettingsChanged);
  appScope.add(() => {
    appSettingsService.off('app-settings:changed', handleFileSearchSettingsChanged);
  });
  const providerOverrideSettings = createProviderOverrideSettings(db);
  const modelProviderKeys = createModelProviderKeys(encryptedAppSecretsStore);
  // Reads process.env lazily, so it sees the PATH the login-shell probe fills in.
  const usageLimits = createUsageLimitsService({
    listAccounts: async () =>
      (await appSettingsService.get('modelProviders')).providers.filter(isOfficialAccount),
    accountHome: (account) => prepareAccountHome(account),
  });
  const REMOTE_ACCESS_TOKEN_KEY = 'remote-access-token';
  const REMOTE_ACCESS_KEY_HASH = 'remote-access-key-hash';
  const remoteAccessAuth = createRemoteAccessAuth({
    file: join(app.getPath('userData'), 'remote-access-devices.json'),
    readKeyHash: async () =>
      (await encryptedAppSecretsStore.getSecret(REMOTE_ACCESS_KEY_HASH))?.expose() ?? null,
    writeKeyHash: (hash) =>
      hash === null
        ? encryptedAppSecretsStore.deleteSecret(REMOTE_ACCESS_KEY_HASH)
        : encryptedAppSecretsStore.setSecret(
            REMOTE_ACCESS_KEY_HASH,
            secret(hash, REMOTE_ACCESS_KEY_HASH)
          ),
    // Whoever signs in, the person at this computer should hear about it.
    onDevicePaired: (device) => {
      if (!Notification.isSupported()) return;
      new Notification({
        title: 'New device signed in to remote access',
        body: `${device.name}${device.lastAddress ? ` · ${device.lastAddress}` : ''}`,
      }).show();
    },
  });
  appScope.add(() => remoteAccessAuth.flush());
  const remoteAccess = createRemoteAccessService({
    getSettings: () => appSettingsService.get('remoteAccess'),
    onSettingsChanged: (listener) => {
      const handler = (key: AppSettingsKey) => {
        if (key === 'remoteAccess') listener();
      };
      appSettingsService.on('app-settings:changed', handler);
      return () => appSettingsService.off('app-settings:changed', handler);
    },
    readToken: async () =>
      (await encryptedAppSecretsStore.getSecret(REMOTE_ACCESS_TOKEN_KEY))?.expose() ?? null,
    writeToken: (token) =>
      encryptedAppSecretsStore.setSecret(
        REMOTE_ACCESS_TOKEN_KEY,
        secret(token, REMOTE_ACCESS_TOKEN_KEY)
      ),
    server: createRemoteAccessServer({
      rendererRoot: join(app.getAppPath(), 'out', 'renderer'),
      openSession: openRemoteWireSession,
      info: () => ({ name: hostname(), version: app.getVersion() }),
      auth: remoteAccessAuth,
      usageStats: (from, to) => usageStats.localUsage(from, to),
    }),
    auth: remoteAccessAuth,
    warn: (message, details) => log.warn(message, details),
  });
  void remoteAccess.apply();
  appScope.add(() => remoteAccess.dispose());
  const REMOTE_SERVER_TOKEN_PREFIX = 'remote-server-token:';
  const remoteClient = createRemoteClientService({
    storePath: join(app.getPath('userData'), 'remote-servers.json'),
    secrets: {
      read: async (serverId) =>
        (
          await encryptedAppSecretsStore.getSecret(`${REMOTE_SERVER_TOKEN_PREFIX}${serverId}`)
        )?.expose() ?? null,
      write: (serverId, token) =>
        encryptedAppSecretsStore.setSecret(
          `${REMOTE_SERVER_TOKEN_PREFIX}${serverId}`,
          secret(token, `${REMOTE_SERVER_TOKEN_PREFIX}${serverId}`)
        ),
      remove: (serverId) =>
        encryptedAppSecretsStore.deleteSecret(`${REMOTE_SERVER_TOKEN_PREFIX}${serverId}`),
    },
    localVersion: app.getVersion(),
    setRouting: setRemoteRouting,
    setBrowserProxyPort: setRemoteBrowserProxyPort,
    reloadWindow: () => getMainWindow()?.webContents.reload(),
    warn: (message, details) => log.warn(message, details),
    launchWindow: launchAppWindow,
    windowServer: takeWindowServer(),
    setWindowTitle: setWindowComputer,
  });
  // Before the gateway registers controllers: window traffic waits for the choice.
  void remoteClient.start();
  appScope.add(() => remoteClient.dispose());
  const priceCatalog = createPriceCatalog({
    cacheFile: join(app.getPath('userData'), 'model-prices.json'),
  });
  const usageStats = createUsageStatsService({
    scanner: createUsageScanner({
      cacheFile: join(app.getPath('userData'), 'usage-stats-cache.json'),
      roots: async () =>
        usageSessionRoots(
          { claude: mainAgentHome('claude'), codex: mainAgentHome('codex') },
          { home: homedir(), env: process.env }
        ),
      openCodeCalls: createOpenCodeCallReader({ home: homedir(), env: process.env }),
      catalog: priceCatalog,
      warn: (message, details) => log.warn(message, details),
    }),
    attribution: () =>
      readUsageAttribution({
        db,
        providers: async () => (await appSettingsService.get('modelProviders')).providers,
        agentConfig: (agentId) => providerOverrideSettings.getItem(agentId),
      }),
    catalog: priceCatalog,
    refreshCatalog: () => priceCatalog.refreshNow(),
    catalogFetchedAt: () => priceCatalog.fetchedAt(),
    listings: (model) => priceCatalog.listings(model),
    pricingFile: join(app.getPath('userData'), 'usage-pricing.json'),
    machineName: () => hostname().replace(/\.(local|lan|home)$/i, ''),
    remotes: async () => {
      const { servers } = await remoteClient.state();
      const signedIn = await Promise.all(
        servers.map(async (server) => ({
          name: server.name,
          baseUrl: server.baseUrl,
          token:
            (
              await encryptedAppSecretsStore.getSecret(`${REMOTE_SERVER_TOKEN_PREFIX}${server.id}`)
            )?.expose() ?? null,
        }))
      );
      return signedIn.flatMap((remote) =>
        remote.token ? [{ name: remote.name, baseUrl: remote.baseUrl, token: remote.token }] : []
      );
    },
  });
  // Read the agents' session history once Emdash has settled, so the first look is quick.
  const usageWarmTimer = setTimeout(() => usageStats.warm(), 60_000);
  appScope.add(() => clearTimeout(usageWarmTimer));
  const effectiveAgentConfig = createEffectiveAgentConfig({
    getAgentConfig: (agentId) => providerOverrideSettings.getItem(agentId),
    getProviders: async () => (await appSettingsService.get('modelProviders')).providers,
    getApiKey: modelProviderKeys.read,
    prepareAgentProvider: (agent) => prepareAgentProvider(agent),
    prepareAccountHome: (account) => prepareAccountHome(account),
    ensureCodexModelCatalog: (catalog) => ensureCodexModelCatalog(catalog),
    readKnownCodexModels: () => readKnownCodexModels(),
    warn: (message, details) => log.warn(message, details),
  });
  const workspacePlacement = new WorkspacePlacementResolver({
    broker: runtimes,
    getSettings: () => appSettingsService,
    findProjectByPath: (host, projectPath) => getProjectByPath(db, host, projectPath),
    // Placement is record-only and must not depend on Host attachment.
    getStoredProjectWorktreeRoot: async (projectId) => {
      const stored = await loadStoredGitSettings(db, projectId);
      return stored.worktreeRoot;
    },
  });
  const lifecycleParticipants = createWorkspaceLifecycleParticipants({
    acquireFileSearchRoot: fileSearchRuntime.acquireRoot,
    releaseFileSearchRoot: fileSearchRuntime.releaseRoot,
    stopPreviewServers: (projectId, workspaceId) =>
      previewServerService.stopForWorkspace(projectId, workspaceId),
  });
  const taskSessionManager = new TaskSessionManager({
    db,
    runtimes,
    workspaceIdentity,
    deactivateWorkspaceParticipants: (identity) =>
      deactivateWorkspaceParticipants(lifecycleParticipants, identity),
  });
  // Each project's requirements list, one KV row per project; agents add to it over MCP.
  const requirementsService = new RequirementsService({
    store: new AppDbKeyValueStore<Record<string, ProjectRequirements>>(db, 'requirements', log),
    emit: (event) => requirementsEvents.emit(undefined, event),
  });
  // Agent control: Emdash's own MCP tools for every local agent (see agent-control).
  const agentControl = createAgentControlDispatcher({
    emit: (request) => agentControlEvents.emit(undefined, request),
  });
  appScope.add(() => agentControl.dispose());
  const AGENT_CONTROL_SECRET_KEY = 'agent-control-secret';
  const agentControlServer = (async () => {
    let stored = (await encryptedAppSecretsStore.getSecret(AGENT_CONTROL_SECRET_KEY))?.expose();
    if (!stored) {
      stored = randomBytes(32).toString('base64url');
      await encryptedAppSecretsStore.setSecret(
        AGENT_CONTROL_SECRET_KEY,
        secret(stored, AGENT_CONTROL_SECRET_KEY)
      );
    }
    const server = await startAgentControlServer({
      secret: Buffer.from(stored),
      version: app.getVersion(),
      resolveCaller: (conversationId) =>
        resolveAgentCaller(
          db,
          async (workspaceId) => (await workspaceIdentity.resolve(workspaceId))?.path ?? null,
          conversationId
        ),
      dispatch: (caller, action) => agentControl.dispatch(caller, action),
      usageLimits: () => usageLimits.get(),
      requirements: requirementsService,
    });
    appScope.add(() => server.close());
    return server;
  })().catch((error: unknown) => {
    log.warn('agent control: MCP server unavailable', { error: String(error) });
    return null;
  });
  const agentControlUrl = async (conversationId: string) =>
    (await agentControlServer)?.urlFor(conversationId) ?? null;
  // Emdash's skill and MCP library, handed to every agent it starts (see agent-library).
  const agentLibrary = createAgentLibraryService({
    home: homedir(),
    getSettings: () => appSettingsService.get('agentLibrary'),
    onSettingsChanged: (listener) => {
      const handler = (key: AppSettingsKey) => {
        if (key === 'agentLibrary') listener();
      };
      appSettingsService.on('app-settings:changed', handler);
      return () => appSettingsService.off('app-settings:changed', handler);
    },
    listLocalWorkspaces: () => listLocalWorkspaces(db),
    refreshSkillCatalog: async () => {
      const local = await runtimes.client(LOCAL_HOST_REF);
      if (local.success) await local.data.agentConfig.refreshSkills({});
    },
    warn: (message, details) => log.warn(message, details),
    // Late-bound: the GitHub credential reader is built further down in this
    // phase; the library only asks for a token after boot completes.
    getGitHubToken: async () => {
      const accountId = await providerAccountRegistry.getDefaultAccountId('github');
      if (!accountId) return null;
      const credentials = await readGitHubCredentials(accountId, 'github.com');
      return credentials.success ? credentials.data.accessToken : null;
    },
  });
  appScope.add(() => agentLibrary.dispose());
  void agentLibrary.resyncAll();
  /** Emdash's own tools first, then the library servers for the project. */
  const launchMcpServers = async (
    conversationId: string,
    projectId: string
  ): Promise<LaunchMcpServer[]> => {
    const url = await agentControlUrl(conversationId);
    const library = await launchableMcpServers(
      await agentLibrary.launchMcpServers(projectId),
      (message, details) => log.warn(message, details)
    );
    return [
      ...(url ? [{ name: 'emdash', transport: 'http' as const, url }] : []),
      ...library.filter((server) => server.name !== 'emdash'),
    ];
  };
  const prepareAgentLaunch = async (input: {
    conversationId: string;
    projectId: string;
    workspacePath: string;
  }) => {
    await agentLibrary.prepareWorkspace({
      projectId: input.projectId,
      path: input.workspacePath,
    });
    return acpMcpServers(await launchMcpServers(input.conversationId, input.projectId));
  };
  // When this Emdash began naming Cursor terminal sessions; older terminals resume the old way.
  const cursorSessionsNamedSince = (async () => {
    const key = 'conversations:cursorSessionsNamedSince';
    const stored = await desktopKeyValueStore.get(key);
    if (!stored.success) return new Date(0);
    if (typeof stored.data === 'string') return new Date(stored.data);
    const now = new Date();
    await desktopKeyValueStore.set(key, now.toISOString());
    return now;
  })();
  // Cursor plugin folders live under the skill library's own metadata dir: a root of
  // our own that never carries spaces, holding per-conversation MCP configs.
  const cursorPluginRoot = join(homedir(), SKILL_LIBRARY_DIRNAME, '.emdash', 'cursor-plugins');
  runInBackground('cursor-plugin-prune', () => pruneCursorPluginDirs(cursorPluginRoot));
  const tuiConversationDependencies = {
    db,
    getProviderConfig: (providerId: string, override?: ModelSourceOverride) =>
      effectiveAgentConfig(providerId, override),
    getTaskSettings: () => appSettingsService.get('tasks'),
    getTerminalColorEnv,
    // Late-bound: the git-credentials service is constructed further down in
    // this phase; sessions only call this after boot completes.
    resolveSessionGitCredentials: (params: { projectId: string; host: HostRef }) =>
      gitCredentials.resolveSessionSpec(params),
    prepareAgentLaunch: async (params: {
      conversationId: string;
      providerId: string;
      projectId: string;
      workspacePath: string;
      host: HostRef;
      env: Record<string, string>;
      autoApprove: boolean;
    }) => {
      // Skills and MCP servers live on this computer; remote agents keep their own.
      if (!isLocalHostRef(params.host)) return null;
      await agentLibrary.prepareWorkspace({
        projectId: params.projectId,
        path: params.workspacePath,
      });
      const servers = await launchMcpServers(params.conversationId, params.projectId);
      if (params.providerId === 'cursor') {
        if (servers.length === 0) return null;
        const dir = await writeCursorPluginDir(cursorPluginRoot, params.conversationId, servers);
        // Cursor asks before it starts a plugin's MCP servers unless told to approve them.
        return {
          args: ['--plugin-dir', dir, ...(params.autoApprove ? ['--approve-mcps'] : [])],
          env: {},
        };
      }
      return terminalLaunchForMcp(params.providerId, servers, params.env);
    },
    beforeResume: async (params: {
      conversationId: string;
      providerId: string;
      sessionId: string;
      cwd: string;
    }) => {
      if (params.providerId !== 'cursor') return;
      await resumeLegacyCursorConversation({
        db,
        ...params,
        namedSince: await cursorSessionsNamedSince,
      }).catch((error: unknown) => {
        log.warn('Could not give an older Cursor terminal its session back', { error });
      });
    },
  };
  const projectAttachmentAdapter = createProjectAttachmentAdapter({
    db,
    taskSessions: taskSessionManager,
    createGitRepository: (client, repository, resolveEffectiveSettings) =>
      new GitRepositoryService(client, repository, resolveEffectiveSettings),
    createGitRepositoryFetch: (client, repository, getBaseRemote) =>
      new GitRepositoryFetchService(client, repository, getBaseRemote),
    ensureAbsoluteDir: (client, rootPath, absolutePath, options) =>
      ensureAbsoluteDir(async () => client, rootPath, absolutePath, options),
    runtimes,
    getProjectDefaults: async () => ({
      tmuxByDefault: (await appSettingsService.get('project')).tmuxByDefault,
    }),
    migrateAppWorktreeRoot: async () => {
      const local = await runtimes.client(LOCAL_HOST_REF);
      if (!local.success) throw new Error('local host runtime unavailable');
      const hostSettings = local.data.hostSettings;
      await migrateAppWorktreeRootToLocalHostDefault({
        getAppDefaultWorktreeDirectoryOverride: async () => {
          const { overrides } = await appSettingsService.getWithMeta('localProject');
          return Object.hasOwn(overrides, 'defaultWorktreeDirectory')
            ? overrides.defaultWorktreeDirectory
            : undefined;
        },
        clearAppDefaultWorktreeDirectory: () =>
          appSettingsService.resetField('localProject', 'defaultWorktreeDirectory'),
        localHostSettings: {
          getWorktreeRoot: async () => {
            const state = await hostSettings.get();
            return state.success
              ? { success: true, worktreeRoot: state.data.settings.worktreeRoot }
              : { success: false };
          },
          setWorktreeRoot: async (worktreeRoot) => {
            const result = await hostSettings.update({ worktreeRoot });
            return { success: result.success };
          },
        },
      });
    },
  });
  const projectManager = createProjectAttachmentManager({
    scope: appScope,
    availability: desktopRuntimes.hostAvailability,
    adapter: projectAttachmentAdapter,
  });
  const sessionLaunchContexts = new TaskSessionLaunchContextResolver({
    db,
    projects: projectManager,
    runtimes,
    workspaceIdentity,
  });
  const previewServerAccess = new PreviewServerAccessService({
    projects: projectManager,
    previewServers: previewServerService,
  });
  appScope.add(
    projectEvents.on('project:deleted', (projectId) => {
      previewServerAccess.forgetProject(projectId);
    })
  );
  const projectSettingsService = new ProjectSettingsService({
    db,
    projects: projectManager,
    workspaceIdentity,
  });
  const createConversationProvider = (options: TaskProviderOpts) =>
    new TuiConversationProvider(
      {
        projectId: options.projectId,
        taskId: options.taskId,
        taskPath: options.taskPath,
        host: options.host,
        tuiAgents: options.tuiAgents,
        launchContextSource: options.launchContextSource,
      },
      tuiConversationDependencies
    );
  const workspaceCreations = new WorkspaceCreations();
  const sessionCleanupDependencies: SessionCleanupDependencies = {
    getAcpRuntimeClient: async () => clients.acp,
    getProjectTerminals: (projectId: string) => {
      const attached = projectManager.requireAttached(projectId);
      return attached.success ? attached.data.terminals : undefined;
    },
    getTerminalsRuntimeClient,
    getTuiAgentsRuntimeClient,
  };
  const lifecycleSessions: TaskSessionCleanup = {
    resolve: (database, scope, context) =>
      resolveLifecycleSessionTargets(sessionCleanupDependencies, database, scope, context),
    killAcp: (database, scope, targets) =>
      killLifecycleAcpSessions(sessionCleanupDependencies, database, scope, targets),
    killTerminals: (database, scope, context, targets) =>
      killLifecycleTerminalSessions(sessionCleanupDependencies, database, scope, context, targets),
  };
  // Legacy consumers still read raw SSH reachability. Task/workspace mutations use
  // ProjectAttachmentManager.requireAttached instead.
  const hostIsReachable = createHostReachabilityProbe(infrastructure.ssh.manager);
  const taskService = new TaskService({
    db,
    projects: projectManager,
    sessions: taskSessionManager,
    workspacePlacement,
    runtimes,
    lifecycleParticipants,
    sessionLaunchContexts,
    createConversationProvider,
    workspaceIdentity,
    creations: workspaceCreations,
    // Plain task deletion (spec §3): no kernel submit; the host-artifact half rides
    // the workspace removal verbs and the reconcile-sweep tombstones.
    deletion: {
      db,
      runtimes,
      sessionCleanup: lifecycleSessions,
      getMementosRuntimeClient,
      telemetry: telemetryService,
      evictFileSearchRoot: fileSearchRuntime.evictRoot,
      clearEditorBuffersUnderLocalPath: (path) =>
        database.editorBuffer.clearBuffersUnderLocalPath(path),
    },
  });
  const searchService = createSearchService({
    db,
    sqlite,
    acquireWorkspaceRuntime: (workspaceId) =>
      acquireWorkspaceRuntime(runtimes, workspaceIdentity, workspaceId),
    searchFileSearchRoot,
    getSearchExclusions: async () => (await appSettingsService.get('files')).searchExclude,
    tasks: taskService,
  });
  searchService.initialize();
  const automationRuntime = {
    runtimes,
    getProjectById: (projectId: string) => getProjectById(db, projectId),
  };
  const automationsService = new AutomationsService({
    db,
    runtime: automationRuntime,
    buildDeployment: (automation) =>
      buildAutomationDeployment(
        {
          db,
          getProjectById: (projectId) => getProjectById(db, projectId),
          getRepoFacts: async (project) => {
            const attached = projectManager.requireAttached(project.id);
            return attached.success ? attached.data.repoFacts.get() : null;
          },
          resolveWorkspace: (workspaceId) => workspaceIdentity.resolve(workspaceId),
          resolveWorktreePool: (project) => workspacePlacement.resolveWorktreePool(project),
        },
        automation
      ),
  });
  installAutomationTelemetry(telemetryService, automationsService);
  installTaskTelemetry(telemetryService, taskService, taskSessionManager);

  // Unmigrated string-typed consumers get the documented plaintext view over
  // the Secret-typed secrets store (see toPlaintextSecretStore).
  const plaintextSecrets = toPlaintextSecretStore(encryptedAppSecretsStore);
  const promptLibraryService = createPromptLibraryService({
    db,
    keyValueStore: new AppDbKeyValueStore<PromptLibraryKV>(db, 'prompt-library', log),
  });
  const notificationService = createNotificationService({
    db,
    settings: appSettingsService,
    isAppFocused,
    onAgentEvent: (handler) => agentStatusService.on('agent:event', handler),
    resolveProviderName: (providerId) => {
      try {
        return getPluginMetadata(providerId).name;
      } catch {
        return providerId;
      }
    },
    logger: log,
    createSystemSink: createSystemNotificationSink,
  });
  const legacyAccountImports = new LegacyAccountImports(db, plaintextSecrets, log);
  const legacyIntegrationAccounts = new LegacyIntegrationAccountsMigration(
    db,
    providerAccountRegistry,
    plaintextSecrets,
    legacyAccountImports
  );
  await migrateGitHubJsonCredentials(providerAccountRegistry);
  const integrationAccountStore = new IntegrationAccountStore(providerAccountRegistry, (id) =>
    legacyIntegrationAccounts.run(id)
  );
  setIntegrationAccountStore(integrationAccountStore);
  const onIntegrationAccountsChanged = (providerId: string) => {
    integrationsEvents.emit(undefined, { type: 'accounts-changed', providerId });
  };
  const integrationConnections = new IntegrationConnectionService(
    providerAccountRegistry,
    integrationAccountStore,
    telemetryService,
    log,
    onIntegrationAccountsChanged
  );
  setIntegrationConnectionService(integrationConnections);
  const accountService = createEmdashAccountService({
    authServerClient: new AccountAuthServerClient(),
    credentials: new AccountCredentialStore(plaintextSecrets, log),
    keyValueStore: new AppDbKeyValueStore<AccountKVSchema>(db, 'account', log),
    oauthClient: new AccountOAuthClient(executeOAuthFlow),
    providerTokenDispatcher: new ProviderTokenDispatcher(
      new IntegrationOAuthTokens(integrationConnections, log)
    ),
  });
  integrationAccountStore.setRenewer(
    EMDASH_OAUTH_CREDENTIAL_SOURCE,
    createEmdashOAuthRenewer((provider, providerAccountId) =>
      accountService.renewProviderToken(provider, providerAccountId)
    )
  );
  // A renewal that failed under one Emdash account (e.g. "not linked") says
  // nothing about the next one, so retry after every sign-in or sign-out.
  const forgetEmdashRenewalFailures = () =>
    integrationAccountStore.forgetRenewalFailures(EMDASH_OAUTH_CREDENTIAL_SOURCE);
  accountService.on('accountChanged', forgetEmdashRenewalFailures);
  accountService.on('accountCleared', forgetEmdashRenewalFailures);
  const integrationDeviceFlow = new IntegrationDeviceFlowService({
    connections: integrationConnections,
    logger: log,
  });
  setIntegrationDeviceFlowService(integrationDeviceFlow);
  appScope.add(() => integrationDeviceFlow.dispose());
  const providerAccounts = new ProviderAccountService(providerAccountRegistry, {
    prepare: (providerId) => legacyIntegrationAccounts.run(providerId),
    onAccountsChanged: onIntegrationAccountsChanged,
    onRemoved: (account) => {
      if (account.providerId === 'github') clearOctokitCache(account.meta?.host, account.accountId);
      telemetryService.capture('integration_disconnected', { provider: account.providerId });
    },
  });
  setProviderAccountService(providerAccounts);
  const legacyGitHubTokens = new LegacyGitHubTokenMigrationStore(db, plaintextSecrets);
  const githubCliImporter = new GitHubCliAccountImportService(
    integrationConnections,
    runLocalCommand,
    githubIdentityClient
  );
  const readGitHubCredentials = createGitHubCredentialReader(
    integrationAccountStore,
    providerAccountRegistry
  );
  const resolveProjectIntegrationAccount = createProjectIntegrationAccountResolver({
    getStoredIntegrationAccounts: (projectId) => loadStoredIntegrationAccounts(db, projectId),
    listAccounts: (providerId) => providerAccounts.listAccounts(providerId),
    getProjectRepositoryContext: async (projectId) => {
      const project = await getProjectById(db, projectId);
      if (!project) throw new Error(`Project ${projectId} does not exist.`);
      const attached = projectManager.requireAttached(projectId);
      const [storedGitSettings, repoFacts] = await Promise.all([
        loadStoredGitSettings(db, projectId),
        attached.success ? attached.data.repoFacts.get() : null,
      ]);
      return { storedGitSettings, repoFacts };
    },
  });
  // Emdash git credential helper (spec: github-git-settings §4): loopback
  // server holding tokens desktop-side plus the policy seam consumed by the
  // terminals/source-control controllers and TUI sessions.
  const gitCredentialServer = new GitCredentialServer({
    resolveProjectIntegrationAccount,
    listAccounts: (providerId = 'github') =>
      listProviderAccountSummaries(providerAccountRegistry, providerId),
    readCredentials: readGitHubCredentials,
    readIntegrationCredentials: createIntegrationCredentialReader(
      integrationAccountStore,
      providerAccountRegistry
    ),
    reportRejectedCredentials: (integrationId, accountId, credentials) =>
      integrationAccountStore.reportRejected(integrationId, accountId, credentials),
    logger: log,
  });
  appScope.add(() => {
    gitCredentialServer.stop();
  });
  const gitCredentials = createGitCredentialsService({
    getAgentGitCredentialsSetting: async (projectId) => {
      const settings = await loadStoredGitSettings(db, projectId);
      return settings.agentGitCredentials ?? DEFAULT_AGENT_GIT_CREDENTIALS;
    },
    resolveProjectIntegrationAccount,
    listAccounts: (providerId = 'github') =>
      listProviderAccountSummaries(providerAccountRegistry, providerId),
    channels: gitCredentialServer,
    logger: log,
  });
  const issueProviders = createIssueProviderRegistry({ resolveProjectIntegrationAccount });
  const pullRequestsRegistration = new PullRequestsRegistration({
    getClient: getPullRequestsRuntimeClient,
    onResume: (handler) => {
      powerMonitor.on('resume', handler);
      return () => {
        powerMonitor.off('resume', handler);
      };
    },
    onWorkerReady: (handler) =>
      desktopRuntimes.workers.pullRequests.onStateChanged((state) => {
        if (state.kind === 'ready') handler();
      }),
    onProjectOpened: (handler) => projectManager.on('projectOpened', handler),
    onProjectClosed: (handler) => projectManager.on('projectClosed', handler),
    subscribeToProjectRemotes: (projectId, handler) => {
      const attached = projectManager.requireAttached(projectId);
      if (!attached.success || !attached.data.hasRepository) return undefined;
      return attached.data.gitRepository.subscribeRemotes(handler);
    },
    resolveProjectRepositoryUrls: async (projectId) => {
      const attached = projectManager.requireAttached(projectId);
      if (!attached.success || !attached.data.hasRepository) return [];
      const remotes = (
        await attached.data.git.repository.model
          .state(attached.data.repository, 'remotes')
          .snapshot()
      ).data.remotes;
      return await pullRequestRepositoryUrls(
        (url) => repositoryRouter.route(url),
        remotes.map((remote) => remote.url),
        (integrationId) => pullRequestsPluginRegistry.get(integrationId) !== undefined
      );
    },
    resolveProjectAuthContext: async (projectId, integrationId) =>
      await resolvePullRequestAccount(
        resolveProjectIntegrationAccount,
        projectId,
        integrationId,
        integrationPluginRegistry.get(integrationId)?.metadata.name ?? integrationId
      ),
  });
  // Answers the PR worker's per-sync "as whom" requests through the blessed
  // resolver (spec: github-git-settings §8); before this binding, identity
  // requests fail closed and the worker skips the sync.
  bindPullRequestSyncIdentityResolver((repositoryUrl, integrationId) =>
    pullRequestsRegistration.resolveSyncIdentity(repositoryUrl, integrationId)
  );
  bindPullRequestIntegrationResolver((repositoryUrl) =>
    resolvePullRequestIntegration((url) => repositoryRouter.route(url), repositoryUrl)
  );
  const githubRepositories = createGitHubRepositoryService({
    listAccounts: () => providerAccounts.listAccounts('github'),
    readCredentials: readGitHubCredentials,
  });
  const gitlabRepositories = createGitLabRepositoryService({
    listAccounts: () => providerAccounts.listAccounts('gitlab'),
    readCredentials: createIntegrationCredentialReader(
      integrationAccountStore,
      providerAccountRegistry
    ),
  });
  // Run-once upgrade step (spec: github-git-settings §10): the legacy
  // single-token import lives behind an app-DB done-flag instead of a
  // recurring startup backfill. The KV github-account backfill retired into
  // Drizzle data migration 0046.
  const githubLegacyTokenImport = new GitHubLegacyTokenImportStep(
    legacyAccountImports,
    legacyGitHubTokens,
    githubIdentityClient
  );
  const githubServices = {
    cliImport: githubCliImporter,
    legacyTokenImport: githubLegacyTokenImport,
    repositories: githubRepositories,
  };
  setCoreServiceInstances({
    account: accountService,
    appSettings: appSettingsService,
    notifications: notificationService,
    promptLibrary: promptLibraryService,
    providerSettings: providerOverrideSettings,
  });
  try {
    await step('services:telemetry-init', () =>
      telemetryService.initialize({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        installSource: app.isPackaged ? 'dmg' : 'dev',
      })
    );
  } catch (error) {
    log.warn('telemetry init failed:', error);
  }

  wireAccountTelemetry(accountService);
  projectSettingsService.initialize();
  pullRequestsRegistration.initialize();
  appService.initialize({
    acquireWorkspaceRuntime: createDesktopWorkspaceRuntimeAcquirer(runtimes, workspaceIdentity),
    emitHostEvent: (event) => desktopHostEvents.emit(undefined, event),
  });
  appScope.add(() => appService.dispose());
  await step('services:app-settings-init', () => appSettingsService.initialize());
  setTrayVisible((await appSettingsService.get('interface')).showTrayIcon);
  applyNativeTheme(await appSettingsService.get('theme'));
  await step('services:automations-init', () => automationsService.initialize());
  await step('services:notifications-init', () => notificationService.initialize());
  installUpdateNotifications(notificationService);
  browserWebContentsRegistry.setKeyboardSettings(await appSettingsService.get('keyboard'));
  setBrowserCorsRelaxationSettings(await appSettingsService.get('browser'));
  await step('services:prompt-library-init', () => promptLibraryService.initialize());
  // Plain project deletion (spec §3): the cascade reuses the task session cleanup and
  // the workspace removal verbs; nothing submits to the operations kernel.
  const projectDeletion: ProjectDeletionDependencies = {
    db,
    runtimes,
    automations: automationsService,
    getMementosRuntimeClient,
    logger: log,
    projects: projectManager,
    pullRequests: pullRequestsRegistration,
    requirements: requirementsService,
    sessionCleanup: lifecycleSessions,
    telemetry: telemetryService,
  };
  // Push-based mirror of each host's workspace registry (ADR 0005).
  const workspaceRegistrySync = new WorkspaceRegistrySyncService({
    db,
    runtimes,
    scope: appScope,
    onError: (context, error) => log.warn(context, { error }),
  });
  const workspaceRegistryBackfill = new WorkspaceRegistryBackfillService({
    db,
    runtimes,
    onError: (context, error) => log.warn(context, { error }),
  });
  const conversationPreferences = getProviderSettingsService(db);
  appScope.add(() => conversationPreferences.dispose());
  const conversationSync = new ConversationSyncService({
    db,
    runtimes,
    scope: appScope,
    onError: (context, error) => log.warn(context, { error }),
  });
  const conversationBackfill = new ConversationBackfillService({
    db,
    runtimes,
    onError: (context, error) => log.warn(context, { error }),
  });
  // The operations kernel is gone (ADR 0006 demolition): best-effort cleanup of the
  // orphaned SQLite store older builds left next to the app database.
  cleanupLegacyOperationsDatabases(log);
  // The reconcile sweep (ADR 0006): tombstoned mirror rows are the durable deletion
  // queue; they converge whenever their host is reachable. Boot trigger: the local
  // host attaches once its registry sync is up; the service's internal 10-minute
  // backstop is the retry vehicle (per-item backoff, no separate scheduler).
  const reconcileSweep = new ReconcileSweepService({
    scope: appScope,
    onError: (context, error) => log.warn(context, { error: String(error) }),
  });
  reconcileSweep.registerKind(createWorkspaceDeletionSweepKind({ db, runtimes }));
  // Conversations sweep after workspaces: the same-host ordering heuristic lets a
  // workspace cascade's freshly written conversation tombstones converge in the same
  // pass; correctness never depends on the order (ADR 0006).
  reconcileSweep.registerKind(createConversationDeletionSweepKind({ db, runtimes }));
  const hostAttachments = new HostAttachmentRegistry({
    scope: appScope,
    hosts: infrastructure.hosts,
    logger: log,
  });
  // Registration order is the per-host convergence order. Backfills precede the
  // authoritative live subscription, and workspace convergence precedes deletion sweeps.
  hostAttachments.register({
    label: 'conversation-sync',
    async attach(host) {
      await conversationBackfill.backfillHost(host);
      await conversationSync.attachHost(host);
    },
    detach: (host) => conversationSync.detachHost(host),
  });
  hostAttachments.register({
    label: 'workspace-registry-sync',
    async attach(host) {
      const backfill = await workspaceRegistryBackfill.backfillHost(host);
      if (backfill.status !== 'complete') return;
      await workspaceRegistrySync.attachHost(host);
      reconcileSweep.attachHost(host);
    },
    detach(host) {
      workspaceRegistrySync.detachHost(host);
      reconcileSweep.detachHost(host);
    },
  });
  hostAttachments.register({
    label: 'automations-tombstone-sweep',
    attach: async (host) => {
      if (!isLocalHostRef(host)) await automationsService.sweepDeletionTombstones();
    },
    detach: () => {},
  });
  // "Sync local settings" (spec: release-code-prep §6): mirror the local
  // watcherExclude to hosts whose toggle is ON — on attach, on local change,
  // and when the toggle flips ON. Fire-and-forget so a slow host never blocks
  // the per-host attachment chain; failures are logged inside the service.
  const localSettingsSync = new LocalSettingsSync({
    runtimes,
    getWatcherExclude: async () => (await appSettingsService.get('files')).watcherExclude,
    isSyncEnabled: async (connectionId) => {
      const machines = await infrastructure.ssh.machines.getMachines();
      return machines.find((machine) => machine.id === connectionId)?.syncLocalSettings ?? false;
    },
    logger: log,
  });
  hostAttachments.register({
    label: 'local-settings-sync',
    attach: (host) => {
      void localSettingsSync.attachHost(host);
    },
    detach: (host) => localSettingsSync.detachHost(host),
  });
  const handleLocalSettingsSyncChanged = (key: AppSettingsKey) => {
    if (key === 'files') void localSettingsSync.handleLocalSettingsChanged();
  };
  appSettingsService.on('app-settings:changed', handleLocalSettingsSyncChanged);
  appScope.add(() => {
    appSettingsService.off('app-settings:changed', handleLocalSettingsSyncChanged);
  });
  appScope.add(
    infrastructure.ssh.machines.on('machine:sync-local-settings-changed', (event) => {
      void localSettingsSync.handleSyncToggled(event.connectionId, event.enabled);
    })
  );
  // Tombstoned-while-reachable trigger: constructed here (composition root) and
  // installed on the module bridge the tombstone write paths poke.
  const reconcileSweepTriggers = createReconcileSweepTriggers();
  installReconcileSweepTriggers(reconcileSweepTriggers);
  appScope.add(
    reconcileSweepTriggers.subscribe((host) => {
      void reconcileSweep.sweepHost(host);
    })
  );
  const sessionHygieneDependencies = {
    agentStatus: agentStatusService,
    createSessionIntentStores: createDesktopSessionIntentStores,
    logger: log,
  };
  const sessionHygieneSweep = startPeriodicSweep({
    scope: appScope,
    intervalMs: 10 * 60 * 1000,
    run: () => sweepSessionHygiene(db, sessionHygieneDependencies),
    onError: (error) => {
      log.warn('session hygiene sweep failed', { error: String(error) });
    },
  });
  void sessionHygieneSweep.runNow().catch((error) => {
    log.warn('session hygiene sweep failed', { error: String(error) });
  });
  return {
    account: accountService,
    automations: automationsService,
    github: githubServices,
    gitlabRepositories,
    gitCredentials,
    hostIsReachable,
    hostAttachments,
    issueProviders,
    notifications: notificationService,
    previewServerAccess,
    promptLibrary: promptLibraryService,
    requirements: requirementsService,
    projectDeletion,
    projects: projectManager,
    projectSettings: projectSettingsService,
    providerSettings: providerOverrideSettings,
    effectiveAgentConfig,
    // Costs shown anywhere count prices set by hand (Usage statistics → Prices).
    priceCatalog: () => usageStats.pricedCatalog(),
    modelProviderKeys,
    usageLimits,
    usageStats,
    agentControl,
    agentLibrary,
    prepareAgentLaunch,
    remoteAccess,
    remoteClient,
    pullRequestsRegistration,
    search: searchService,
    sessionLaunchContexts,
    taskService,
    taskSessions: taskSessionManager,
    usage,
    workspacePlacement,
    conversationSync,
    reconcileSweep,
  };
}
