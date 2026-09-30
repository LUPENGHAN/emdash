import { serializedHostRefSchema } from '@emdash/core/primitives/host/api';
import {
  runtimeResolveErrorSchema,
  type RuntimeResolveError,
} from '@emdash/core/primitives/runtime-resolution/api';
import {
  acpApiContract,
  acpSessionStartModeSchema,
  acpSetOptionErrorSchema,
  sessionSummarySchema,
  setOptionResultSchema,
} from '@emdash/core/runtimes/acp/api/client';
import { tuiAgentsContract, tuiSessionListSchema } from '@emdash/core/runtimes/tui-agents/api';
import { attachmentErrorSchema } from '@emdash/core/services/attachments/api';
import { conversationAttachmentsContract } from '@emdash/core/services/attachments/api';
import type { Result } from '@emdash/shared';
import {
  defineContract,
  downloadFile,
  eventStream,
  fallible,
  liveLog,
  liveModel,
  liveState,
  procedure,
  uploadFile,
} from '@emdash/wire/rpc';
import { z } from 'zod';
import {
  projectAttachmentErrorSchema,
  type ProjectAttachmentError,
} from '@core/features/projects/api/attachments';
import type {
  Conversation,
  ConversationEvent,
  CreateConversationParams,
  HandoffPreparation,
  HostConversationRow,
  ImportableSession,
  SessionCost,
  SubagentSummary,
} from '@core/primitives/conversations/api';
import {
  localTerminalFilesSchema,
  preparedTerminalFileSchema,
} from '@core/services/attachments/api/terminal-files';
import { providerSettingsContract } from './provider-settings';

const conversationKey = z.object({ conversationId: z.string() });
const conversationLocation = z.object({
  projectId: z.string(),
  taskId: z.string(),
  conversationId: z.string(),
});
const attachmentKey = conversationKey.extend({ attachmentId: z.string() });
const hostSessionsKey = z.object({
  host: serializedHostRefSchema,
  projectId: z.string(),
});

const projectAttachmentFailureSchema = z.object({
  success: z.literal(false),
  error: projectAttachmentErrorSchema,
});
const runtimeResolveFailureSchema = z.object({
  success: z.literal(false),
  error: runtimeResolveErrorSchema,
});

type ProjectRuntimeResult<OutputSchema extends z.ZodTypeAny> =
  z.output<OutputSchema> extends Result<infer Data, infer Error>
    ? Result<Data, Error | RuntimeResolveError | ProjectAttachmentError>
    : never;

function runtimeFallibleProcedure<
  InputSchema extends z.ZodTypeAny,
  OutputSchema extends z.ZodTypeAny,
>(input: InputSchema, output: OutputSchema) {
  return procedure({
    input,
    output: z.union([
      output,
      runtimeResolveFailureSchema,
      projectAttachmentFailureSchema,
    ]) as z.ZodType<ProjectRuntimeResult<OutputSchema>>,
  });
}

function projectAttachmentErrorUnion<ErrorSchema extends z.ZodTypeAny>(error: ErrorSchema) {
  return z.union([error, runtimeResolveErrorSchema, projectAttachmentErrorSchema]);
}

const desktopAcpSessions = liveModel({
  key: hostSessionsKey,
  states: {
    list: liveState({ data: z.record(z.string(), sessionSummarySchema) }),
  },
});

const desktopTuiSessions = liveModel({
  key: hostSessionsKey,
  states: {
    list: liveState({ data: tuiSessionListSchema }),
  },
});

const conversationsAcpContract = defineContract({
  attach: runtimeFallibleProcedure(conversationKey, acpApiContract.attach.output),
  startSession: runtimeFallibleProcedure(
    conversationKey.extend({ mode: acpSessionStartModeSchema }),
    acpApiContract.startSession.output
  ),
  terminate: runtimeFallibleProcedure(
    acpApiContract.terminate.input,
    acpApiContract.terminate.output
  ),
  sendPrompt: runtimeFallibleProcedure(
    acpApiContract.sendPrompt.input,
    acpApiContract.sendPrompt.output
  ),
  editQueuedPrompt: runtimeFallibleProcedure(
    acpApiContract.editQueuedPrompt.input,
    acpApiContract.editQueuedPrompt.output
  ),
  deleteQueuedPrompt: runtimeFallibleProcedure(
    acpApiContract.deleteQueuedPrompt.input,
    acpApiContract.deleteQueuedPrompt.output
  ),
  changeQueuePromptOrder: runtimeFallibleProcedure(
    acpApiContract.changeQueuePromptOrder.input,
    acpApiContract.changeQueuePromptOrder.output
  ),
  cancelTurn: runtimeFallibleProcedure(
    acpApiContract.cancelTurn.input,
    acpApiContract.cancelTurn.output
  ),
  setOption: fallible({
    input: acpApiContract.setOption.input,
    data: setOptionResultSchema.extend({ preferenceSaveError: z.string().optional() }),
    error: projectAttachmentErrorUnion(acpSetOptionErrorSchema),
  }),
  resolvePermission: runtimeFallibleProcedure(
    acpApiContract.resolvePermission.input,
    acpApiContract.resolvePermission.output
  ),
  exportAcpTranscript: runtimeFallibleProcedure(
    acpApiContract.exportAcpTranscript.input,
    acpApiContract.exportAcpTranscript.output
  ),
  exportRawAcpLog: runtimeFallibleProcedure(
    acpApiContract.exportRawAcpLog.input,
    acpApiContract.exportRawAcpLog.output
  ),
  loadHistory: runtimeFallibleProcedure(
    acpApiContract.loadHistory.input,
    acpApiContract.loadHistory.output
  ),
  sessions: desktopAcpSessions,
  session: acpApiContract.session,
  terminalOutput: liveLog({
    key: conversationKey.extend({ terminalId: z.string() }),
  }),
});

const conversationsTuiContract = defineContract({
  startSession: runtimeFallibleProcedure(
    tuiAgentsContract.startSession.input,
    tuiAgentsContract.startSession.output
  ),
  resume: runtimeFallibleProcedure(tuiAgentsContract.resume.input, tuiAgentsContract.resume.output),
  stop: runtimeFallibleProcedure(tuiAgentsContract.stop.input, tuiAgentsContract.stop.output),
  delete: runtimeFallibleProcedure(tuiAgentsContract.delete.input, tuiAgentsContract.delete.output),
  kill: runtimeFallibleProcedure(tuiAgentsContract.kill.input, tuiAgentsContract.kill.output),
  sendInput: runtimeFallibleProcedure(
    tuiAgentsContract.sendInput.input,
    tuiAgentsContract.sendInput.output
  ),
  resize: runtimeFallibleProcedure(tuiAgentsContract.resize.input, tuiAgentsContract.resize.output),
  output: tuiAgentsContract.output,
  sessions: desktopTuiSessions,
});

export const conversationsDomain = 'conversations' as const;

export const conversationsContract = defineContract({
  providerSettings: providerSettingsContract,
  attachments: defineContract({
    prepareLocalFiles: fallible({
      input: z.object({ conversationId: z.string(), sources: localTerminalFilesSchema }),
      data: z.array(preparedTerminalFileSchema),
      error: projectAttachmentErrorUnion(attachmentErrorSchema),
    }),
    upload: uploadFile({
      input: conversationAttachmentsContract.attachments.upload.input,
      maxSize: conversationAttachmentsContract.attachments.upload.maxSize,
      result: conversationAttachmentsContract.attachments.upload.result,
      error: projectAttachmentErrorUnion(conversationAttachmentsContract.attachments.upload.error),
    }),
    download: downloadFile({
      input: attachmentKey,
      meta: conversationAttachmentsContract.attachments.download.meta,
      error: projectAttachmentErrorUnion(
        conversationAttachmentsContract.attachments.download.error
      ),
    }),
    delete: runtimeFallibleProcedure(
      attachmentKey,
      conversationAttachmentsContract.attachments.delete.output
    ),
  }),
  getConversations: procedure({
    input: z.void(),
    output: z.custom<Conversation[]>(),
  }),
  createConversation: fallible({
    input: z.custom<CreateConversationParams>(),
    data: z.custom<Conversation>(),
    error: projectAttachmentErrorSchema,
  }),
  deleteConversation: procedure({
    input: conversationLocation,
    output: z.void(),
  }),
  hydrateConversation: fallible({
    input: conversationLocation.extend({
      initialSize: z.object({ cols: z.number(), rows: z.number() }).optional(),
    }),
    data: z.void(),
    error: projectAttachmentErrorSchema,
  }),
  dehydrateConversation: fallible({
    input: conversationLocation,
    data: z.void(),
    error: projectAttachmentErrorSchema,
  }),
  renameConversation: procedure({
    input: z.object({ conversationId: z.string(), name: z.string() }),
    output: z.void(),
  }),
  getConversationsForTask: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.custom<Conversation[]>(),
  }),
  getConversationsForProject: procedure({
    input: z.object({ projectId: z.string() }),
    output: z.custom<Conversation[]>(),
  }),
  /** Sessions started outside Emdash in this task's directory, resumable as conversations. */
  listImportableSessions: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.custom<ImportableSession[]>(),
  }),
  /** Transcript file + first message for handing a conversation to another agent. */
  prepareHandoff: procedure({
    input: z.object({
      conversationId: z.string(),
      /** A summary the source agent wrote (requestHandoffSummary), to lead the message. */
      summaryPath: z.string().optional(),
      /** What the user tells the next agent. */
      note: z.string().optional(),
    }),
    output: z.custom<HandoffPreparation>(),
  }),
  /** Subagents the conversation's agent started in its own process; empty when unknown. */
  listSubagents: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.custom<SubagentSummary[]>(),
  }),
  /** The session's token usage and its cost at API list prices; null when unknown. */
  sessionCost: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.custom<SessionCost | null>(),
  }),
  /** What one of those subagents was asked and answered. */
  readSubagentTranscript: procedure({
    input: z.object({ conversationId: z.string(), subagentId: z.string() }),
    output: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
  }),
  /** The message asking the source agent for a handoff summary, and the file it writes. */
  requestHandoffSummary: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.object({ summaryPath: z.string(), prompt: z.string() }),
  }),
  /** The summary once the source agent finished writing it; null until then. */
  readHandoffSummary: procedure({
    input: z.object({ conversationId: z.string(), summaryPath: z.string() }),
    output: z.string().nullable(),
  }),
  /** Same, for the project's own checkout: its terminal/IDE session history. */
  listProjectImportableSessions: procedure({
    input: z.object({ projectId: z.string() }),
    output: z.custom<ImportableSession[]>(),
  }),
  /**
   * Removes a session from the agent's own history (files to the system trash; OpenCode
   * deletes it from its database). `removed` is 0 when nothing was saved under the id.
   */
  deleteAgentSession: fallible({
    input: z.object({
      providerId: z.enum(['claude', 'codex', 'opencode', 'pi', 'oh-my-pi', 'cursor']),
      sessionId: z.string().min(1),
    }),
    data: z.object({ removed: z.number() }),
    error: z.object({ message: z.string() }),
  }),
  markConversationSeen: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.void(),
  }),
  // Machine-page surface (spec §8): host-scoped registry reads plus link-free management.
  listHostConversations: procedure({
    input: z.object({
      location: z.enum(['local', 'remote']),
      sshConnectionId: z.string().nullable(),
    }),
    output: z.custom<HostConversationRow[]>(),
  }),
  linkConversationToTask: procedure({
    input: z.object({ conversationId: z.string(), projectId: z.string(), taskId: z.string() }),
    output: z.void(),
  }),
  deleteHostConversation: procedure({
    input: z.object({ conversationId: z.string() }),
    output: z.void(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<ConversationEvent>() }),
  acp: conversationsAcpContract,
  tui: conversationsTuiContract,
});

export type ConversationsContract = typeof conversationsContract;
