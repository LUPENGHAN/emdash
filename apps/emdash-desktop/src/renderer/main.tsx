// Must run first: browser access stand-ins for the Electron preload (see browser-host).
import '@renderer/lib/runtime/browser-host';
import {
  connectSession,
  createChatContext,
  createChatState,
  createChatView,
  pinTopMode,
} from '@emdash/chat-ui';
import { when } from 'mobx';
import ReactDOM from 'react-dom/client';
import { installAgentControl } from '@core/features/agent-control/contributions/browser/install-agent-control';
import { installChatUiRuntime } from '@core/features/conversations/api/browser/chat/chat-ui-runtime';
import { configureDevPerfClient } from '@core/features/dev-perf/api/browser/client';
import { installMonacoFacetBinder } from '@core/features/editor/browser/monaco/install-monaco-facet-binder';
import { monacoBootstrap } from '@core/features/editor/browser/monaco/monaco-bootstrap';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { installRequirementNotices } from '@core/features/requirements/contributions/browser/install-requirement-notices';
import { prefetchAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { initSoundPlayer, soundPlayer } from '@core/features/settings/browser/sound-player';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { popoutWindowId } from '@core/features/workbench/api/browser/popout-mode';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { workbenchSidebarMemento } from '@core/features/workbench/contributions/mementos';
import { appStoreContributions } from '@core/manifests/browser/app-scoped-stores';
import { featureViewRuntimes } from '@core/manifests/browser/browser-contributions';
import { viewCatalog } from '@core/manifests/browser/view-catalog';
import { mementoCatalog } from '@core/manifests/shared/memento-catalog';
import { log } from '@core/primitives/logging/browser/logger';
import { getMementosWireClient } from '@core/primitives/mementos/api/client';
import '@fontsource-variable/inter/index.css';
import '@emdash/ui/style.css';
import '@emdash/chat-ui/style.css';
import './index.css';
import 'devicon/devicon.min.css';
import 'katex/dist/katex.min.css';
import { configureMementos, initMementos } from '@core/primitives/mementos/browser';
import { MementoClientProvider, SubjectProvider } from '@core/primitives/mementos/react';
import {
  workbenchHistoryMemento,
  workbenchNavigationMemento,
} from '@core/primitives/navigation/api/mementos';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { createAppScope } from '@core/primitives/scoped-stores/browser';
import { appSubject } from '@core/primitives/subjects/api';
import { assertViewRuntimesComplete, registerViewRuntime } from '@core/primitives/views/react';
import { ErrorBoundary } from '@renderer/error-boundary';
import {
  dismissBootSplash,
  initBootSplash,
  showBootSplashEscapeHatch,
} from '@renderer/lib/boot/boot-splash';
import {
  appQueriesSettled,
  raceSplashGate,
  SPLASH_GATE_TIMEOUT_MS,
  waitForActiveProjectContext,
} from '@renderer/lib/boot/splash-gate';
import { wireExternalLinkRequests } from '@renderer/lib/external-link-requests';
import { getDesktopWireClient } from '@renderer/lib/runtime/desktop-wire-client';
import { seedDesktopWire } from '@renderer/lib/runtime/seed-desktop-wire';
import { seedRendererNavigationHost } from '@renderer/lib/runtime/seed-navigation-host';
import { initRendererPerfVitals } from '@renderer/utils/perf-vitals';
import { initNotificationDeliveryListener } from '@root/src/core/services/notifications/browser';
import { App } from './App';
import { PopoutApp, preparePopout } from './app/popout-app';
import { wireNavigationTelemetry } from './lib/stores/navigation-telemetry';

const bootstrapStartedAt = performance.now();
let lastBootMarkAt = bootstrapStartedAt;
function bootMark(mark: string, extra?: Record<string, unknown>): void {
  const now = performance.now();
  log.info('boot-timeline renderer', {
    mark,
    sincePageStartMs: Math.round(now),
    sinceBootstrapMs: Math.round(now - bootstrapStartedAt),
    sincePreviousMarkMs: Math.round(now - lastBootMarkAt),
    ...extra,
  });
  lastBootMarkAt = now;
}

async function bootstrap() {
  bootMark('bootstrap-start');
  // The static splash from index.html is already painted; wire its watchdog
  // escape hatch before anything that could block.
  initBootSplash();
  // Core owns wire access through the seeded-connection seam; seed it before
  // React mounts so any slice can reach the wire without host imports.
  seedDesktopWire();

  // Navigation lives in core behind a seeded host seam; the bootstrap hands it
  // the aggregated view catalog before the app scope creates the stores.
  seedRendererNavigationHost();

  installChatUiRuntime({
    connectSession,
    createChatContext,
    createChatState,
    createChatView,
    pinTopMode,
  });
  // A pop-out window shows one task's panes; app-wide duties (agent control, link
  // prompts, notification sounds, navigation history) stay with the main window.
  const popoutId = popoutWindowId;
  if (!popoutId) {
    wireExternalLinkRequests();
    installAgentControl();
    installRequirementNotices();
  }
  // Its layout must be in place before the task's view is built.
  const popout = popoutId ? await preparePopout(popoutId) : null;

  // Builds and activates all app-scoped stores (projects, machines, sidebar,
  // updates) before React mounts.
  createAppScope([...appStoreContributions]);
  // Give the app-global OpenFileStore its Monaco implementation before any
  // file tab can acquire facets (handle creation awaits Monaco internally).
  installMonacoFacetBinder();
  // Monaco starts first but is never awaited before render: facet handles
  // resolve it internally, so editors opened in the first second still work.
  void monacoBootstrap
    .init()
    .catch((error: unknown) => {
      log.warn('[monaco-bootstrap] init failed:', error);
    })
    .then(() => bootMark('monaco-ready'));
  initSoundPlayer();
  if (!popoutId) {
    initNotificationDeliveryListener((sound, dedupeKey) => soundPlayer.play(sound, dedupeKey));
  }
  initRendererPerfVitals();
  configureDevPerfClient(async () => (await getDesktopWireClient()).devPerf);

  // Stores may acquire memento spaces while project data loads, so initialize
  // the singleton before starting any store construction.
  configureMementos({
    getWireClient: getMementosWireClient,
    catalog: mementoCatalog,
    onError: (error) => log.error('Memento operation failed:', error),
  });
  const mementoClient = await initMementos();
  bootMark('mementos-initialized');

  void prefetchAppSettingsKey('interface');
  void prefetchAppSettingsKey('browser');

  for (const contribution of featureViewRuntimes) registerViewRuntime(contribution);
  assertViewRuntimesComplete(viewCatalog);

  const appSpace = mementoClient.subject(appSubject({}));
  const historyHandle = appSpace.handle(workbenchHistoryMemento);
  const legacyNavigationHandle = appSpace.handle(workbenchNavigationMemento);
  const sidebarHandle = appSpace.handle(workbenchSidebarMemento);
  const projectsLoaded = getProjectManagerStore()
    .load()
    .then(() => bootMark('projects-loaded'));
  // Memento reads queue behind the wire until the backend registers its
  // controllers, so navigation restore is a gate condition rather than a
  // render prerequisite. On the timeout path the restore lands after render;
  // the stores are observable, so the last-active view snaps in when ready.
  const navigationRestored = popout
    ? projectsLoaded
        .then(() => getProjectManagerStore().hydrateProjectContext(popout.projectId))
        // The project's tasks load after its context; the task view needs this one.
        .then(() =>
          when(() => getTaskStore(popout.projectId, popout.taskId) !== undefined, {
            timeout: 30_000,
          }).catch(() => {})
        )
        // Editors create themselves once, with Monaco already loaded; the main window's
        // splash gate gives it time, a pop-out shows its panes at once.
        .then(() => monacoBootstrap.init().catch(() => {}))
        .then(() =>
          getNavigation().navigate(
            taskViewDef({ projectId: popout.projectId, taskId: popout.taskId })
          )
        )
    : appSpace.ready.then(() => {
        bootMark('memento-handles-ready');
        getNavigation().attachMemento(historyHandle, legacyNavigationHandle);
        getSidebarStore().attachMemento(sidebarHandle);
        wireNavigationTelemetry(getNavigation());
      });
  const sidebarInitialized = Promise.all([navigationRestored, projectsLoaded]).then(() => {
    if (!popout && !sidebarHandle.hasStoredValue) getSidebarStore().expandAllProjects();
  });

  // The gate below awaits only desktop context for the Project required by the restored view.
  const activeProjectReady = waitForActiveProjectContext({
    navigationRestored,
    projectsLoaded,
    activeProjectId: () => {
      const ref = getNavigation().currentRef;
      return ref.viewId === 'project' || ref.viewId === 'task'
        ? (ref.params as { projectId?: string }).projectId
        : undefined;
    },
    hydrateProjectContext: (projectId) => getProjectManagerStore().hydrateProjectContext(projectId),
  });

  const gate = raceSplashGate(
    [sidebarInitialized, activeProjectReady, appQueriesSettled()],
    SPLASH_GATE_TIMEOUT_MS
  );

  // Render immediately behind the splash; the gate only decides when the
  // splash lifts. Avoid double-mount in dev which can duplicate PTY sessions.
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ErrorBoundary>
      <MementoClientProvider client={mementoClient}>
        <SubjectProvider subject={appSubject({})}>
          {popout ? <PopoutApp popoutId={popout.id} /> : <App />}
        </SubjectProvider>
      </MementoClientProvider>
    </ErrorBoundary>
  );
  bootMark('react-render-called');

  const outcome = await gate;
  dismissBootSplash();
  bootMark('app-content-ready', { gate: outcome });
  if (!popout) window.electronAPI.reportBootUsable();
}

bootstrap().catch((error: unknown) => {
  log.error('Renderer bootstrap failed:', error);
  // A fatal bootstrap error leaves nothing behind the splash; surface the
  // escape hatch so the user can restart or reach recovery.
  showBootSplashEscapeHatch();
});
