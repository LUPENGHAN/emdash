import { asAgentProviderId } from '@emdash/plugins/agents/types';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { getCoordinationClient } from '@core/features/coordination/api/browser/client';
import { getModelGatewayClient } from '@core/features/model-gateway/api/browser/client';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { getAppSettingsClient } from '@core/services/settings/api/client';

const host = { type: 'local', id: 'local' } as const;
export async function configureSelectionFixture(input: {
  origin: string;
  codexWrapper: string;
  mainId: string;
}) {
  const settings = await getAppSettingsClient();
  await settings.update({
    key: 'modelProviders',
    value: {
      providers: [
        {
          id: 'selection-a',
          name: 'Selection provider A',
          protocol: 'anthropic',
          baseUrl: `${input.origin}/anthropic`,
          models: ['upstream-a'],
        },
        {
          id: 'selection-b',
          name: 'Selection provider B',
          protocol: 'openai-chat',
          baseUrl: `${input.origin}/openai/v1`,
          models: ['catalog-b'],
        },
      ],
    },
  });
  const agents = await getAgentsClient();
  for (const id of ['selection-a', 'selection-b'])
    await agents.setModelProviderKey({ providerId: id, apiKey: `isolated-${id}` });
  const installation = await agents.setUsedInstallation({
    host,
    id: 'codex',
    selection: { kind: 'path', path: input.codexWrapper },
  });
  if (!installation.success) throw new Error(installation.error.type);
  const gateway = await getModelGatewayClient();
  await gateway.saveModels({
    models: [
      {
        id: 'shared',
        alias: 'shared-code',
        name: 'Shared code model',
        enabled: true,
        revision: 1,
        providerId: 'selection-a',
        protocolModels: { anthropic: { upstreamModel: 'upstream-a' } },
        protocolPolicy: { mode: 'auto' },
      },
    ],
  });
  for (const [id, effort] of [
    ['claude', 'high'],
    ['codex', 'low'],
  ]) {
    const saved = await agents.updateSettings({
      host,
      id,
      config: { modelSource: 'gateway:models', sourceModel: 'shared-code', effort },
    });
    if (!saved.success) throw new Error(saved.error.type);
  }
  await (
    await getCoordinationClient()
  ).update({
    id: input.mainId,
    delegationDefaults: {
      agent: 'claude',
      connection: 'gateway',
      model: 'shared-code',
      effort: 'medium',
    },
  });
  await gateway.start();
}

/** Uses the same saved Agent selections passed by the ordinary task creation form. */
export async function createOrdinarySelectionFixture(projectId: string) {
  const settings = await (await getAgentsClient()).getSettings({ host, id: 'claude' });
  if (!settings.success) throw new Error(settings.error.type);
  const manager = getTaskManagerStore(projectId);
  if (!manager) throw new Error('The fixture task manager is unavailable');
  const taskId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await manager.createTask({
    id: taskId,
    projectId,
    taskConfig: {
      version: '1',
      name: 'Ordinary default selection',
      initialConversation: {
        id: conversationId,
        provider: asAgentProviderId('claude'),
        type: 'pty',
        initialPrompt: 'Check the default selection',
        modelSource: settings.data.value.modelSource ?? null,
        sourceModel: settings.data.value.sourceModel,
        effort: settings.data.value.effort ?? null,
      },
    },
    workspaceConfig: {
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: 'ordinary-selection',
        fromBranch: { type: 'local', branch: 'main' },
      },
      workspace: { kind: 'new-worktree' },
    },
  });
  await manager.provisionTask(taskId);
  const result = await (
    await getConversationsClient()
  ).hydrateConversation({ projectId, taskId, conversationId });
  if (!result.success) throw new Error(result.error.type);
  return { taskId, conversationId };
}

export async function changeSelectionDefaultsFixture(mainId: string) {
  const agents = await getAgentsClient();
  for (const [id, effort] of [
    ['claude', 'low'],
    ['codex', 'xhigh'],
  ]) {
    const saved = await agents.updateSettings({ host, id, config: { effort } });
    if (!saved.success) throw new Error(saved.error.type);
  }
  await (
    await getCoordinationClient()
  ).update({
    id: mainId,
    delegationDefaults: {
      agent: 'claude',
      connection: 'gateway',
      model: 'shared-code',
      effort: 'low',
    },
  });
  const gateway = await getModelGatewayClient();
  const current = (await gateway.status()).models?.find((model) => model.id === 'shared');
  if (!current) throw new Error('The shared fixture model is unavailable');
  await gateway.saveModels({
    models: [
      {
        id: 'shared',
        alias: 'shared-code',
        name: 'Shared code model',
        enabled: true,
        revision: current.revision,
        providerId: 'selection-b',
        protocolModels: { 'openai-chat': { upstreamModel: 'catalog-b' } },
        protocolPolicy: { mode: 'auto' },
      },
    ],
  });
}

export async function selectionFixtureUsage() {
  const gateway = await getModelGatewayClient();
  return { usage: await gateway.usage({ limit: 100 }), routes: await gateway.routes() };
}

export async function setSelectionSupplierKeyFixture(enabled: boolean) {
  const agents = await getAgentsClient();
  if (enabled)
    await agents.setModelProviderKey({ providerId: 'selection-b', apiKey: 'isolated-selection-b' });
  else await agents.clearModelProviderKey({ providerId: 'selection-b' });
}
