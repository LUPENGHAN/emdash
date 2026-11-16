import { formatHostRef } from '@emdash/core/primitives/host/api';
import {
  parseHostRef,
  type HostRef,
  type SerializedHostRef,
} from '@emdash/core/primitives/host/api';
import { acpErr, providerOptionValuesSchema } from '@emdash/core/runtimes/acp/api/client';
import { err, ok, type Result } from '@emdash/shared';
import { createKeyedLanes } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import type { LiveSource } from '@emdash/wire/rpc';
import { createController, type CallMeta, type Controller } from '@emdash/wire/rpc';
import { createConversationOperations } from '@core/features/conversations/node/controller';
import type { CompensationRunner } from '@core/features/conversations/node/createConversation';
import { deleteAgentSession } from '@core/features/conversations/node/delete-agent-session';
import { localConversation } from '@core/features/conversations/node/handoff/prepare-conversation-handoff';
import { sessionCost, type PriceCatalog } from '@core/features/conversations/node/session-cost';
import type { ModelSourceOverride } from '@core/features/model-providers/api';
import type { ProjectAttachmentError } from '@core/features/projects/api';
import {
  requireAttachedProjectOrThrow,
  withAttachedProject,
} from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { TaskSessionLaunchContextResolver } from '@core/features/tasks/api/node/task-session-launch-context';
import type { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import type { TelemetryService } from '@core/primitives/telemetry/api/telemetry';
import type { AppDb } from '@core/services/app-db/node/db';
import {
  prepareTerminalFiles,
  type TerminalFileSources,
} from '@core/services/attachments/node/prepare-terminal-files';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import { conversationsContract } from '../api';
import {
  throwConversationsRuntimeResolveError,
  type ConversationsAcpStartInput,
  type ConversationsHostRuntimesClient,
  type ConversationsRuntimeBroker,
  type ConversationsRuntimeResolveError as RuntimeResolveError,
} from '../api/runtime-adapter';
import {
  resolveConversationRuntimeTarget,
  type ConversationRuntimeTarget,
  type WorkspaceIdentityResolver,
} from './conversation-runtime-target';
import { conversationWireEvents } from './event-host';
import { getProviderSettingsService } from './provider-settings-service';

type ConversationRuntimeHooks = Readonly<{
  recordTuiInput(target: ConversationRuntimeTarget): Promise<void>;
}>;

export type CreateConversationsWireControllerOptions = Readonly<{
  db: AppDb;
  getDefaultEffort?: (agentId: string) => Promise<string | undefined>;
  getHiddenContext?: (taskId: string) => Promise<string | undefined>;
  /** Moves a file or folder to the system trash (agent session files). */
  trashItem?: (target: string) => Promise<void>;
  terminalFileSources: TerminalFileSources;
  runtimes: ConversationsRuntimeBroker;
  workspaceIdentity: WorkspaceIdentityResolver;
  resolveTarget?: (conversationId: string) => Promise<ConversationRuntimeTarget>;
  hooks?: ConversationRuntimeHooks;
  getProviderEnv?: (
    providerId: string,
    override?: ModelSourceOverride
  ) => Promise<Record<string, string> | undefined>;
  sessionLaunchContexts: Pick<TaskSessionLaunchContextResolver, 'resolve'>;
  /**
   * Readies a local workspace for a chat agent (Emdash's skills) and returns the MCP
   * servers Emdash adds to its session (its own tools and library).
   */
  prepareAgentLaunch?: (input: {
    conversationId: string;
    projectId: string;
    workspacePath: string;
  }) => Promise<NonNullable<ConversationsAcpStartInput['extraMcpServers']>>;
  logger: Logger;
  projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
  telemetry: TelemetryService;
  taskSessions: Pick<TaskSessionManager, 'getTask'>;
  withCompensation: CompensationRunner;
  hostIsReachable: (hostRef: SerializedHostRef) => boolean;
  /** API list prices, for sessions' equivalent cost. */
  priceCatalog?: () => Promise<PriceCatalog>;
}>;

export function createConversationsWireController(
  options: CreateConversationsWireControllerOptions
): Controller {
  const resolveTarget =
    options.resolveTarget ??
    ((conversationId) =>
      resolveConversationRuntimeTarget(
        conversationId,
        options.workspaceIdentity,
        options.db,
        options.getProviderEnv,
        options.sessionLaunchContexts,
        options.prepareAgentLaunch
      ));
  const hooks = options.hooks ?? createDefaultRuntimeHooks(options);
  const configurationChanges = createKeyedLanes();
  const conversationOperations = createConversationOperations({
    db: options.db,
    taskSessions: options.taskSessions,
    telemetry: options.telemetry,
    withCompensation: options.withCompensation,
    runtimes: options.runtimes,
    hostIsReachable: options.hostIsReachable,
    workspaceIdentity: options.workspaceIdentity,
  });
  const target = (conversationId: string) => resolveTarget(conversationId);
  const run = <T, E>(
    conversationId: string,
    work: (
      client: ConversationsHostRuntimesClient,
      target: ConversationRuntimeTarget
    ) => Promise<Result<T, E>>
  ) => withConversationRuntime(options, target(conversationId), work);

  const acpSessions = forwardLiveModel(conversationsContract.acp.sessions, (key, name) =>
    resolveProjectRuntimeSource(
      options,
      key.projectId,
      Promise.resolve(parseHostRef(key.host)),
      (client) => client.acp.sessions.state(undefined, name).asLiveSource()
    )
  );
  const acpSession = forwardLiveModel(conversationsContract.acp.session, (key, name) =>
    resolveConversationRuntimeSource(options, target(key.conversationId), (client) =>
      client.acp.session.state(key, name).asLiveSource()
    )
  );
  const tuiSessions = forwardLiveModel(conversationsContract.tui.sessions, (key, name) =>
    resolveProjectRuntimeSource(
      options,
      key.projectId,
      Promise.resolve(parseHostRef(key.host)),
      (client) => client.tuiAgents.sessions.state(undefined, name).asLiveSource()
    )
  );

  const settings = getProviderSettingsService(options.db);
  return createController(conversationsContract, {
    providerSettings: {
      model: settings.model,
      patch: ({ patch, ...key }) => settings.patch(key, patch),
    },
    attachments: {
      prepareLocalFiles: ({ conversationId, sources }, meta) =>
        run(conversationId, (client, target) =>
          prepareTerminalFiles({
            host: target.host,
            sources,
            localFiles: options.terminalFileSources,
            upload: (file) =>
              client.conversations.attachments.upload({ conversationId }, file, callOptions(meta)),
            remove: (attachmentId) =>
              client.conversations.attachments.delete({ conversationId, attachmentId }),
            signal: meta.signal,
            logger: options.logger,
          })
        ),
      upload: ({ conversationId }, file, meta) =>
        run(conversationId, (client) =>
          client.conversations.attachments.upload({ conversationId }, file, callOptions(meta))
        ),
      download: ({ conversationId, attachmentId }, meta) =>
        openAttachmentDownload(options, target(conversationId), attachmentId, callOptions(meta)),
      delete: ({ conversationId, attachmentId }, meta) =>
        run(conversationId, (client) =>
          client.conversations.attachments.delete(
            { conversationId, attachmentId },
            callOptions(meta)
          )
        ),
    },
    getConversations: () => conversationOperations.getConversations(),
    createConversation: (input) =>
      withAttachedProject(options.projects, input.projectId, async () =>
        ok(
          await conversationOperations.createConversation({
            ...input,
            ...(input.effort === undefined &&
              options.getDefaultEffort && {
                effort: (await options.getDefaultEffort(input.provider)) ?? null,
              }),
          })
        )
      ),
    deleteConversation: ({ projectId, taskId, conversationId }) =>
      conversationOperations.deleteConversation(projectId, taskId, conversationId),
    hydrateConversation: ({ projectId, taskId, conversationId, initialSize }) =>
      withAttachedProject(options.projects, projectId, async () => {
        await conversationOperations.hydrateConversation(
          projectId,
          taskId,
          conversationId,
          initialSize
        );
        return ok<void>();
      }),
    dehydrateConversation: ({ projectId, taskId, conversationId }) =>
      withAttachedProject(options.projects, projectId, async () => {
        await conversationOperations.dehydrateConversation(projectId, taskId, conversationId);
        return ok<void>();
      }),
    renameConversation: ({ conversationId, name }) =>
      conversationOperations.renameConversation(conversationId, name),
    getConversationsForTask: ({ projectId, taskId }) =>
      conversationOperations.getConversationsForTask(projectId, taskId),
    listImportableSessions: ({ taskId }) => conversationOperations.listImportableSessions(taskId),
    prepareHandoff: ({ conversationId, summaryPath, note }) =>
      conversationOperations.prepareHandoff(conversationId, { summaryPath, note }),
    requestHandoffSummary: ({ conversationId }) =>
      conversationOperations.requestHandoffSummary(conversationId),
    listSubagents: ({ conversationId }) => conversationOperations.listSubagents(conversationId),
    sessionCost: async ({ conversationId }) => {
      const row = await localConversation(options.db, conversationId).catch(() => null);
      if (!row?.providerSessionId || !options.priceCatalog) return null;
      return sessionCost(
        row.provider,
        row.providerSessionId,
        row.cwd,
        await options.priceCatalog()
      ).catch(() => null);
    },
    listCompactedSegments: ({ conversationId }) =>
      conversationOperations.listCompactedSegments(conversationId),
    readCompactedSegment: ({ conversationId, index }) =>
      conversationOperations.readCompactedSegment(conversationId, index),
    readSubagentTranscript: ({ conversationId, subagentId }) =>
      conversationOperations.readSubagentTranscript(conversationId, subagentId),
    readHandoffSummary: ({ conversationId, summaryPath }) =>
      conversationOperations.readHandoffSummary(conversationId, summaryPath),
    listProjectImportableSessions: ({ projectId }) =>
      conversationOperations.listProjectImportableSessions(projectId),
    getConversationsForProject: ({ projectId }) =>
      conversationOperations.getConversationsForProject(projectId),
    deleteAgentSession: async ({ providerId, sessionId }) => {
      if (!options.trashItem) return err({ message: 'Deleting agent sessions is unavailable' });
      try {
        return ok({
          removed: await deleteAgentSession(providerId, sessionId, { trash: options.trashItem }),
        });
      } catch (error) {
        return err({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    markConversationSeen: ({ conversationId }) =>
      conversationOperations.markConversationSeen(conversationId),
    listHostConversations: (scope) => conversationOperations.listHostConversations(scope),
    linkConversationToTask: (input) => conversationOperations.linkConversationToTask(input),
    deleteHostConversation: ({ conversationId }) =>
      conversationOperations.deleteHostConversation(conversationId),
    events: conversationWireEvents,
    acp: {
      setOption: (input, meta) =>
        configurationChanges.run(
          input.conversationId,
          meta.signal ?? new AbortController().signal,
          async () => {
            const runtimeTarget = await target(input.conversationId);
            return withConversationRuntime(
              options,
              Promise.resolve(runtimeTarget),
              async (client): ReturnType<ConversationsHostRuntimesClient['acp']['setOption']> => {
                const records = await client.conversations.records
                  .state(undefined, 'list')
                  .snapshot();
                const record = records.data[input.conversationId];
                if (!record) return acpErr.conversationNotFound(input.conversationId);
                const previous = providerOptionValuesSchema.parse(record.config.options ?? {})[
                  input.configId
                ];
                const persisted = await client.conversations.patchConfig({
                  conversationId: input.conversationId,
                  patch: {},
                  mapPatch: {
                    field: 'options',
                    entries: { [input.configId]: input.value },
                    expected: { [input.configId]: previous },
                  },
                });
                if (!persisted.success)
                  return acpErr.setConfigFailed({
                    name: 'PersistenceError',
                    message: persisted.error.message,
                  });
                if (persisted.data.skippedKeys.includes(input.configId))
                  return acpErr.setConfigFailed({
                    name: 'ConfigurationConflict',
                    message:
                      'This setting changed elsewhere. Select it again to apply your choice.',
                  });
                const restorePreviousOption = async () => {
                  const restored = await client.conversations.patchConfig({
                    conversationId: input.conversationId,
                    patch: {},
                    mapPatch: {
                      field: 'options',
                      entries: { [input.configId]: previous ?? null },
                      expected: { [input.configId]: input.value },
                    },
                  });
                  if (!restored.success)
                    throw new Error(
                      `Could not restore previous conversation setting: ${restored.error.message}`
                    );
                };
                let result: Awaited<ReturnType<typeof client.acp.setOption>>;
                try {
                  result = await client.acp.setOption(
                    {
                      conversationId: input.conversationId,
                      configId: input.configId,
                      value: input.value,
                    },
                    callOptions(meta)
                  );
                } catch (error) {
                  await restorePreviousOption();
                  throw error;
                }
                if (!result.success) {
                  await restorePreviousOption();
                  return result;
                }
                if (runtimeTarget.providerId && input.remember !== false) {
                  try {
                    await settings.patch(
                      {
                        host: formatHostRef(runtimeTarget.host),
                        providerId: runtimeTarget.providerId,
                      },
                      { transport: 'acp', options: { [input.configId]: input.value } }
                    );
                  } catch (error) {
                    return ok({
                      ...result.data,
                      preferenceSaveError: error instanceof Error ? error.message : String(error),
                    });
                  }
                }
                return result;
              }
            );
          }
        ),
      attach: async ({ conversationId }, meta) => {
        const runtimeTarget = await target(conversationId);
        const input = runtimeTarget.acpInput;
        if (!input) throw missingAcpInputError(runtimeTarget);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), (client) =>
          client.acp.attach(input, callOptions(meta))
        );
      },
      startSession: async ({ conversationId, mode }, meta) => {
        const runtimeTarget = await target(conversationId);
        const input = runtimeTarget.acpInput;
        if (!input) throw missingAcpInputError(runtimeTarget);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.acp.startSession(
            { ...input, mode },
            { ...callOptions(meta), timeoutMs: 0 }
          );
          return result;
        });
      },
      loadHistory: (input, meta) =>
        run(input.conversationId, (client) => client.acp.loadHistory(input, callOptions(meta))),
      terminate: (input, meta) =>
        run(input.conversationId, (client) => client.acp.terminate(input, callOptions(meta))),
      sendPrompt: (input, meta) =>
        run(input.conversationId, async (client, target) => {
          const context = await options.getHiddenContext?.(target.taskId);
          return client.acp.sendPrompt(
            context
              ? {
                  ...input,
                  prompt: {
                    ...input.prompt,
                    hiddenContext: [context, input.prompt.hiddenContext]
                      .filter(Boolean)
                      .join('\n\n'),
                  },
                }
              : input,
            { ...callOptions(meta), timeoutMs: 0 }
          );
        }),
      editQueuedPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.editQueuedPrompt(input, callOptions(meta))
        ),
      deleteQueuedPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.deleteQueuedPrompt(input, callOptions(meta))
        ),
      changeQueuePromptOrder: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.changeQueuePromptOrder(input, callOptions(meta))
        ),
      cancelTurn: (input, meta) =>
        run(input.conversationId, (client) => client.acp.cancelTurn(input, callOptions(meta))),
      setAutoApprove: (input, meta) =>
        run(input.conversationId, async (client) => {
          const persisted = await client.conversations.patchConfig({
            conversationId: input.conversationId,
            patch: { autoApprove: input.enabled },
          });
          if (!persisted.success) return acpErr.invalidState(persisted.error.message);
          return client.acp.setAutoApprove(input, callOptions(meta));
        }),
      resolvePermission: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.resolvePermission(input, callOptions(meta))
        ),
      exportAcpTranscript: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.exportAcpTranscript(input, callOptions(meta))
        ),
      exportRawAcpLog: (input, meta) =>
        run(input.conversationId, (client) => client.acp.exportRawAcpLog(input, callOptions(meta))),
      sessions: acpSessions,
      session: acpSession,
      terminalOutput: async ({ conversationId, terminalId }) =>
        resolveConversationRuntimeSource(options, target(conversationId), (client) =>
          client.acp.terminalOutput.handle({ terminalId }).asLiveSource()
        ),
    },
    tui: {
      startSession: (input, meta) =>
        run(input.conversationId, (client) =>
          client.tuiAgents.startSession(input, callOptions(meta))
        ),
      resume: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.resume(input, callOptions(meta))),
      stop: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.stop(input, callOptions(meta))),
      delete: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.delete(input, callOptions(meta))),
      kill: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.kill(input, callOptions(meta))),
      sendInput: async (input, meta) => {
        const runtimeTarget = await target(input.conversationId);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.tuiAgents.sendInput(input, callOptions(meta));
          if (result.success && input.data.includes('\r')) {
            await hooks.recordTuiInput(runtimeTarget);
          }
          return result;
        });
      },
      resize: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.resize(input, callOptions(meta))),
      output: async ({ conversationId }) =>
        resolveConversationRuntimeSource(options, target(conversationId), (client) =>
          client.tuiAgents.output.handle({ conversationId }).asLiveSource()
        ),
      sessions: tuiSessions,
    },
  });
}

function createDefaultRuntimeHooks(
  options: Pick<CreateConversationsWireControllerOptions, 'telemetry'>
): ConversationRuntimeHooks {
  const { telemetry } = options;
  return {
    // Recency is a host fact now: the runtime's activity report feeds
    // `lastSessionActivityAt` and convergence caches it — only telemetry stays client-side.
    async recordTuiInput(target) {
      if (target.providerId) {
        telemetry.capture('agent_run_started', {
          provider: target.providerId,
          project_id: target.projectId,
          task_id: target.taskId,
          conversation_id: target.conversationId,
        });
      }
    },
  };
}

function missingAcpInputError(target: ConversationRuntimeTarget): Error {
  if (target.conversationType === 'acp' && !target.workspacePath) {
    return new Error(
      `Workspace for conversation '${target.conversationId}' is not provisioned yet`
    );
  }
  return new Error(`Conversation '${target.conversationId}' is not an ACP conversation`);
}

async function withConversationRuntime<T, E>(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  work: (
    client: ConversationsHostRuntimesClient,
    target: ConversationRuntimeTarget
  ) => Promise<Result<T, E>>
): Promise<Result<T, E | RuntimeResolveError | ProjectAttachmentError>> {
  const target = await targetPromise;
  return withAttachedProject(options.projects, target.projectId, async () => {
    const result = await options.runtimes.client(target.host);
    if (!result.success) return err(result.error);
    return await work(result.data, target);
  });
}

function callOptions(meta: CallMeta): { signal?: AbortSignal } {
  return meta.signal ? { signal: meta.signal } : {};
}

async function resolveConversationRuntimeSource(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const target = await targetPromise;
  return resolveProjectRuntimeSource(
    options,
    target.projectId,
    Promise.resolve(target.host),
    source
  );
}

async function resolveProjectRuntimeSource(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  projectId: string,
  hostPromise: Promise<HostRef>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  requireAttachedProjectOrThrow(options.projects, projectId);
  return resolveRuntimeSource(options.runtimes, hostPromise, source);
}

async function resolveRuntimeSource(
  runtimes: ConversationsRuntimeBroker,
  hostPromise: Promise<HostRef>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const result = await runtimes.client(await hostPromise);
  if (!result.success) throwConversationsRuntimeResolveError(result.error);
  return source(result.data);
}

async function openAttachmentDownload(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  attachmentId: string,
  call: { signal?: AbortSignal }
) {
  const target = await targetPromise;
  return withAttachedProject(options.projects, target.projectId, async () => {
    const runtime = await options.runtimes.client(target.host);
    if (!runtime.success) return err(runtime.error);
    const result = await runtime.data.conversations.attachments.download(
      { conversationId: target.conversationId, attachmentId },
      call
    );
    if (!result.success) return result;
    return {
      success: true as const,
      data: { meta: result.data.meta, source: result.data.chunks() },
    };
  });
}
