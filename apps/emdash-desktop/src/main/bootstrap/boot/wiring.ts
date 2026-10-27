import { shell } from 'electron';
import type { EmdashAccountService } from '@core/features/account/node/services/emdash-account-service';
import { provisionWorkspaceErrorToWorkspaceError } from '@core/features/workspaces/node/wire-controller';
import type { DesktopControllerContext } from '@core/manifests/node/controllers';
import { appOperations } from '@main/core/app/controller';
import { terminalFileSources } from '@main/core/app/persist-terminal-attachment';
import { appService } from '@main/core/app/service';
import {
  createDependencyManagerResolver,
  ensureAgentDependenciesProbed,
} from '@main/core/dependencies/dependency-managers';
import { getTerminalColorEnv } from '@main/core/terminal-shell/color-env';
import { withCompensation } from '@main/core/utils/compensation';
import { legacyPortOperations } from '@main/db/legacy-port/controller';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { setBrowserCorsRelaxationSettings } from '@main/host/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/host/browser/browser-webcontents-registry';
import { browserOperations } from '@main/host/browser/controller';
import { createDevPerfOperations } from '@main/host/dev-perf/controller-operations';
import { writeRendererLogEntry } from '@main/host/file-logger';
import {
  getPopoutWindow,
  openPopoutWindow,
  returnPopoutTabs,
  returnPopoutWindow,
  setPopoutAlwaysOnTop,
  takePopoutReturns,
  updatePopoutWindow,
} from '@main/host/popout-windows';
import { setTrayVisible } from '@main/host/tray';
import { updateOperations } from '@main/host/updates/controller-operations';
import { applyNativeTheme } from '@main/host/window';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import type { DatabaseBundle } from './phases/database';
import type { ServicesBundle } from './phases/services';

export function wireAccountTelemetry(accountService: EmdashAccountService): void {
  accountService.on('accountChanged', (username, userId, email) => {
    void telemetryService.identify(username, userId, email);
  });
  accountService.on('accountCleared', () => {
    telemetryService.clearIdentity();
  });
}

export type DesktopControllerOptions = Omit<
  DesktopControllerContext,
  'hosts' | 'runtimes' | 'scope' | 'ssh'
>;

export function createDesktopWireOptions(
  database: DatabaseBundle,
  services: ServicesBundle,
  runtimes: DesktopRuntimes
): DesktopControllerOptions {
  const taskService = services.taskService;
  const github = services.github;
  const getDependencyManager = createDependencyManagerResolver(runtimes.clients.hostDependencies);
  return {
    terminalFileSources,
    accountService: services.account,
    agentDependencies: {
      ensureAgentDependenciesProbed,
      getDependencyManager,
    },
    appSettings: database.appSettings,
    automations: services.automations,
    browserOperations,
    compensation: withCompensation,
    db: database.db,
    devPerfOperations: createDevPerfOperations(runtimes),
    editorBuffer: database.editorBuffer,
    github: {
      cliAccountImporter: github.cliImport,
      repositoryService: github.repositories,
    },
    gitlabRepositories: services.gitlabRepositories,
    gitCredentials: services.gitCredentials,
    hostAvailability: runtimes.hostAvailability,
    hostOperations: {
      openExternal: ({ url }) => appOperations.openExternal(url),
      openPath: ({ ref }) => appOperations.openPath(ref),
      showWorkspaceItemInFolder: (input) => appOperations.showWorkspaceItemInFolder(input),
      clipboardWriteText: ({ text }) => appOperations.clipboardWriteText(text),
      persistDroppedBlob: (input) => appOperations.persistDroppedBlob(input),
      persistClipboardImage: () => appOperations.persistClipboardImage(),
      showTerminalContextMenu: (input) => appOperations.showTerminalContextMenu(input),
      setMenuKeybindings: (input) => appOperations.setMenuKeybindings(input),
      quit: () => appOperations.quit(),
      openPopoutWindow: (input) => openPopoutWindow({ ...input, layout: input.layout ?? null }),
      getPopoutWindow: ({ id }) => getPopoutWindow(id),
      updatePopoutWindow: (input) => updatePopoutWindow(input),
      setPopoutAlwaysOnTop: (input) => setPopoutAlwaysOnTop(input),
      returnPopoutWindow: (input) => returnPopoutWindow(input),
      returnPopoutTabs: (input) => returnPopoutTabs(input),
      takePopoutReturns: () => takePopoutReturns(),
      resolveQuitConfirmation: (input) => appOperations.resolveQuitConfirmation(input),
      ackShutdownFlush: () => appOperations.ackShutdownFlush(),
      shutdownReady: () => appOperations.shutdownReady(),
      openIn: (input) => appOperations.openIn(input),
      checkInstalledApps: () => appOperations.checkInstalledApps(),
      listInstalledFonts: (input) => appOperations.listInstalledFonts(input),
      openSelectDirectoryDialog: (input) => appOperations.openSelectDirectoryDialog(input),
      openSelectAudioFileDialog: (input) => appOperations.openSelectAudioFileDialog(input),
      openSelectZipDialog: (input) => appOperations.openSelectZipDialog(input),
      saveTextFile: (input) => appOperations.saveTextFile(input),
      readAudioFileDataUrl: ({ filePath }) => appOperations.readAudioFileDataUrl(filePath),
      minimizeWindow: () => appOperations.minimizeWindow(),
      toggleMaximizeWindow: () => appOperations.toggleMaximizeWindow(),
      closeWindow: () => appOperations.closeWindow(),
      isWindowMaximized: () => appOperations.isWindowMaximized(),
      getAppVersion: () => appOperations.getAppVersion(),
      getElectronVersion: () => appOperations.getElectronVersion(),
      getPlatform: () => appOperations.getPlatform(),
      getPlatformDisplayName: () => appOperations.getPlatformDisplayName(),
      getDiagnosticLogAttachment: () => appOperations.getDiagnosticLogAttachment(),
      submitFeedback: (input) => appOperations.submitFeedback(input),
    },
    hostIsReachable: services.hostIsReachable,
    issueProviders: services.issueProviders,
    legacyPortOperations,
    logger: log,
    loggingOperations: {
      writeRendererLog: (input) => writeRendererLogEntry(input),
    },
    notifications: services.notifications,
    previewServerAccess: services.previewServerAccess,
    projectDeletion: services.projectDeletion,
    promptLibrary: services.promptLibrary,
    requirements: services.requirements,
    memory: services.memory,
    projects: services.projects,
    projectSettings: services.projectSettings,
    providerSettings: services.providerSettings,
    effectiveAgentConfig: services.effectiveAgentConfig,
    priceCatalog: services.priceCatalog,
    modelProviderKeys: services.modelProviderKeys,
    jsonFileDialogs: {
      pickSavePath: (input) => appService.pickJsonSavePath(input),
      pickOpenPath: (input) => appService.pickJsonOpenPath(input),
    },
    usageLimits: services.usageLimits,
    remoteAccess: services.remoteAccess,
    agentControl: services.agentControl,
    agentLibrary: services.agentLibrary,
    prepareAgentLaunch: services.prepareAgentLaunch,
    trashItem: (target: string) => shell.trashItem(target),
    remoteClient: services.remoteClient,
    reconcileSweep: services.reconcileSweep,
    search: services.search,
    sessionLaunchContexts: services.sessionLaunchContexts,
    runtimeClients: {
      getMementosRuntimeClient: async () => runtimes.clients.mementos,
      getPullRequestsRuntimeClient: async () => runtimes.clients.pullRequests,
    },
    settingsRuntime: {
      setKeyboardSettings: (settings) => browserWebContentsRegistry.setKeyboardSettings(settings),
      setBrowserSettings: setBrowserCorsRelaxationSettings,
      setTheme: applyNativeTheme,
      setTrayVisible,
    },
    telemetry: telemetryService,
    taskService,
    taskSessions: services.taskSessions,
    terminalShell: {
      getColorEnv: getTerminalColorEnv,
    },
    updateOperations,
    usage: services.usage,
    usageStats: services.usageStats,
    workspaceIdentity: database.workspaceIdentity,
    workspacePlacement: services.workspacePlacement,
    workspaces: {
      async provisionTask(taskId, signal) {
        const result = await taskService.provisionWorkspace(taskId, signal);
        return result.success
          ? result
          : { success: false, error: provisionWorkspaceErrorToWorkspaceError(result.error) };
      },
      reprovisionWorkspace: (workspaceId, options) =>
        taskService.reprovisionWorkspace(workspaceId, options),
    },
  };
}
