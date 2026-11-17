import { createScope } from '@emdash/shared/concurrency';
import { observe, remote } from '@emdash/wire/state';
import { when } from 'mobx';
import { getAgentLibraryClient } from '@core/features/agent-library/api/browser/client';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { getMachinesClient } from '@core/features/machines/api/browser/client';
import { getModelGatewayClient } from '@core/features/model-gateway/api/browser/client';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import {
  asAvailableProject,
  getProjectStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { hostsContract } from '@core/services/hosts/api';
import { getHostsClient } from '@core/services/hosts/api/client';
import { getAppSettingsClient } from '@core/services/settings/api/client';

export async function isolateRemoteDelegationSkills() {
  const library = await (await getAgentLibraryClient()).effectiveFor({ projectId: null });
  await (
    await getAppSettingsClient()
  ).update({
    key: 'agentLibrary',
    value: {
      skillProjects: Object.fromEntries(
        library.skills.map((skill) => [skill.name, ['unrelated-fixture-project']])
      ),
      mcpServers: [],
    },
  });
}

async function waitForRemoteHost(connectionId: string) {
  const hosts = await getHostsClient();
  const scope = createScope({ label: 'remote-coordination-acceptance:host' });
  const availability = remote(hostsContract.availability, hosts.availability, { scope });
  const model = availability({ host: { type: 'remote', id: connectionId } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastState = 'initializing';
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Remote Host did not become ready: ${lastState}`)),
        60_000
      );
      observe(
        model.states.state,
        (snapshot) => {
          const state = snapshot.value;
          if (!state) return;
          lastState = JSON.stringify(state);
          if (state.kind === 'ready') resolve();
          else if (state.kind === 'unavailable' && ['manual', 'blocked'].includes(state.recovery))
            reject(new Error(state.issue?.message ?? 'Remote Host recovery is blocked'));
        },
        { scope }
      );
    });
  } finally {
    clearTimeout(timer);
    await scope.dispose();
  }
}

/** Real desktop setup through typed clients, with fixture-only paths supplied by the harness. */
export async function prepareRemoteDelegationProject(input: {
  port: number;
  repository: string;
  wrapper: string;
  worktreeRoot: string;
}) {
  const machine = await (
    await getMachinesClient()
  ).saveMachine({
    name: 'Isolated coordination Host',
    host: '127.0.0.1',
    port: input.port,
    username: 'devuser',
    authType: 'password',
    password: 'devpass',
  });
  await (
    await getHostsClient()
  ).requestReady({
    host: { type: 'remote', id: machine.id },
    cause: 'connect',
  });
  await waitForRemoteHost(machine.id);
  const projects = await getProjectsWireClient();
  const created = await projects.createProject({
    type: 'ssh',
    name: 'Remote delegation target',
    path: input.repository,
    connectionId: machine.id,
  });
  if (!created.success) throw new Error(JSON.stringify(created.error));
  await when(
    () => asAvailableProject(getProjectStore(created.data.id))?.host.state.kind === 'ready',
    { timeout: 60_000 }
  );
  const saved = await projects.updateProjectSettings({
    projectId: created.data.id,
    patch: {
      placement: { stored: { worktreeRoot: input.worktreeRoot } },
      gitIdentity: { stored: { defaultBranch: { remote: null, branch: 'main' } } },
    },
  });
  if (!saved.success) throw new Error(JSON.stringify(saved.error));
  const agents = await getAgentsClient();
  const selected = await agents.setUsedInstallation({
    host: { type: 'remote', id: machine.id },
    id: 'claude',
    selection: { kind: 'path', path: input.wrapper },
  });
  if (!selected.success) throw new Error(JSON.stringify(selected.error));
  return { projectId: created.data.id, connectionId: machine.id };
}

export async function setRemoteDelegationConnection(connectionId: string, connected: boolean) {
  const hosts = await getHostsClient();
  const host = { type: 'remote' as const, id: connectionId };
  if (connected) {
    await hosts.requestReady({ host, cause: 'connect' });
    await waitForRemoteHost(connectionId);
  } else await hosts.disconnect({ host });
}

export async function prepareUnsupportedRemoteGateway() {
  await (
    await getAppSettingsClient()
  ).update({
    key: 'modelProviders',
    value: {
      providers: [
        {
          id: 'remote-rejected-supplier',
          name: 'Remote rejection fixture',
          protocol: 'anthropic',
          baseUrl: 'http://127.0.0.1:9',
          models: ['remote-model'],
        },
      ],
    },
  });
  await (
    await getAgentsClient()
  ).setModelProviderKey({
    providerId: 'remote-rejected-supplier',
    apiKey: 'isolated-remote-rejection-key',
  });
  await (await getModelGatewayClient()).start();
}
