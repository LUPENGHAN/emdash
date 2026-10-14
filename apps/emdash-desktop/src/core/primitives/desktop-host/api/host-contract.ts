import { hostFileRefSchema } from '@emdash/core/primitives/path/api';
import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { TabNavigationDirection } from '@core/primitives/keybindings/api';
import { appDetectionStatusSchema } from '@core/primitives/open-in-apps/api/app-detection';
import type { OpenInAppId } from '@core/primitives/open-in-apps/api/open-in-apps';

/**
 * The members of node's `process.platform` union, spelled out so this
 * isomorphic contract (and its browser consumers) need no node ambient types.
 */
export const NODE_PLATFORMS = [
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
] as const;

export type NodePlatform = (typeof NODE_PLATFORMS)[number];

export interface ActiveSessionSummary {
  acpSessions: number;
  localTuiSessions: number;
  remoteSessions: number;
  terminals: number;
  incomplete: boolean;
}

/**
 * A window showing some of a task's tabs outside the main window. `layout` is the
 * task's pane-layout document for that window (validated where it is read).
 */
export type PopoutWindowRecord = {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  alwaysOnTop: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  /** The main-window pane the tabs came from; they go back there when it still exists. */
  originPaneId?: string;
  layout: unknown;
};

/** A pop-out's tabs waiting for the main window to take them back. */
export type PopoutReturn = {
  projectId: string;
  taskId: string;
  layout: unknown;
  originPaneId?: string;
};

export type DesktopHostEvent =
  /** `popoutId`: the pop-out window in front when the menu fired; absent for the main one. */
  | { type: 'menu-command'; commandId: string; popoutId?: string }
  | { type: 'popout-returns-pending' }
  | { type: 'menu-check-for-updates' }
  | { type: 'menu-undo' }
  | { type: 'menu-redo' }
  | {
      type: 'quit-confirmation-requested';
      requestId: string;
      summary: ActiveSessionSummary;
    }
  | { type: 'quit-confirmation-cancelled'; requestId: string }
  | { type: 'shutdown-started' }
  | { type: 'window-maximize-changed'; maximized: boolean }
  | { type: 'external-link-open-requested'; url: string }
  | {
      type: 'tab-navigation-shortcut';
      source: { kind: 'browser'; browserId: string };
      direction: TabNavigationDirection;
    }
  | {
      type: 'browser-app-shortcut';
      source: { kind: 'browser'; browserId: string };
      commandId: string;
    }
  | {
      type: 'terminal-context-menu-action';
      requestId: string;
      action: 'paste' | 'select-all' | 'clear';
    };

type ActionResult = { success: boolean; error?: string };
type RequiredPathResult = { success: true; path: string } | { success: false; error: string };
type NullablePathResult =
  | { success: true; path: string | null }
  | { success: false; error: string };
type OptionalPathResult =
  | { success: true; path: string | undefined }
  | { success: false; error: string };

export const desktopHostDomain = 'host' as const;

export const desktopHostContract = defineContract({
  openExternal: procedure({
    input: z.object({ url: z.string() }),
    output: z.custom<ActionResult>(),
  }),
  openPath: procedure({
    input: z.object({ ref: hostFileRefSchema }),
    output: z.custom<ActionResult>(),
  }),
  showWorkspaceItemInFolder: procedure({
    input: z.object({ workspaceId: z.string(), relativePath: z.string() }),
    output: z.custom<ActionResult>(),
  }),
  clipboardWriteText: procedure({
    input: z.object({ text: z.string() }),
    output: z.custom<ActionResult>(),
  }),
  persistDroppedBlob: procedure({
    input: z.object({
      bytes: z.custom<Uint8Array>(),
      name: z.string().optional(),
      mimeType: z.string().optional(),
    }),
    output: z.custom<RequiredPathResult>(),
  }),
  persistClipboardImage: procedure({
    input: z.void(),
    output: z.custom<NullablePathResult>(),
  }),
  showTerminalContextMenu: procedure({
    input: z.object({
      requestId: z.string(),
      selectionText: z.string().nullable().optional(),
      linkText: z.string().nullable().optional(),
      x: z.number(),
      y: z.number(),
    }),
    output: z.custom<ActionResult>(),
  }),
  setMenuKeybindings: procedure({
    input: z.array(
      z.object({
        commandId: z.string(),
        title: z.string(),
        accelerator: z.string().nullable(),
      })
    ),
    output: z.void(),
  }),
  quit: procedure({ input: z.void(), output: z.custom<ActionResult>() }),
  /** Opens a window showing the given tabs of a task (its pane-layout document). */
  openPopoutWindow: procedure({
    input: z.object({
      projectId: z.string().min(1),
      taskId: z.string().min(1),
      title: z.string(),
      originPaneId: z.string().optional(),
      layout: z.unknown(),
      /** Screen point to put the window's top-left corner near (a tab dropped there). */
      position: z.object({ x: z.number(), y: z.number() }).optional(),
    }),
    output: z.object({ id: z.string() }),
  }),
  getPopoutWindow: procedure({
    input: z.object({ id: z.string() }),
    output: z.custom<PopoutWindowRecord | null>(),
  }),
  updatePopoutWindow: procedure({
    input: z.object({
      id: z.string(),
      layout: z.unknown().optional(),
      title: z.string().optional(),
    }),
    output: z.void(),
  }),
  setPopoutAlwaysOnTop: procedure({
    input: z.object({ id: z.string(), alwaysOnTop: z.boolean() }),
    output: z.void(),
  }),
  /** Sends the window's tabs back to the main window and closes it. */
  returnPopoutWindow: procedure({ input: z.object({ id: z.string() }), output: z.void() }),
  /** Sends some of the window's tabs (a pane-layout document) back to the main window. */
  returnPopoutTabs: procedure({
    input: z.object({ id: z.string(), layout: z.unknown() }),
    output: z.void(),
  }),
  /** The returned tabs the main window has not taken yet; taking clears them. */
  takePopoutReturns: procedure({ input: z.void(), output: z.custom<PopoutReturn[]>() }),
  resolveQuitConfirmation: procedure({
    input: z.object({ requestId: z.string(), confirmed: z.boolean() }),
    output: z.void(),
  }),
  ackShutdownFlush: procedure({ input: z.void(), output: z.void() }),
  shutdownReady: procedure({ input: z.void(), output: z.void() }),
  openIn: procedure({
    input: z.object({
      app: z.custom<OpenInAppId>(),
      path: z.string(),
      isRemote: z.boolean().optional(),
      sshConnectionId: z.string().nullable().optional(),
    }),
    output: z.custom<ActionResult>(),
  }),
  checkInstalledApps: procedure({
    input: z.void(),
    output: z.record(z.string(), appDetectionStatusSchema),
  }),
  listInstalledFonts: procedure({
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.custom<{ success: boolean; fonts: string[]; cached: boolean; error?: string }>(),
  }),
  openSelectDirectoryDialog: procedure({
    input: z.object({ title: z.string(), message: z.string(), defaultPath: z.string().optional() }),
    output: z.string().optional(),
  }),
  openSelectAudioFileDialog: procedure({
    input: z.object({ title: z.string(), message: z.string() }),
    output: z.string().optional(),
  }),
  saveTextFile: procedure({
    input: z.object({ title: z.string(), defaultPath: z.string(), content: z.string() }),
    output: z.custom<OptionalPathResult>(),
  }),
  readAudioFileDataUrl: procedure({
    input: z.object({ filePath: z.string() }),
    output: z.custom<ActionResult & { dataUrl?: string }>(),
  }),
  minimizeWindow: procedure({ input: z.void(), output: z.custom<ActionResult>() }),
  toggleMaximizeWindow: procedure({ input: z.void(), output: z.custom<ActionResult>() }),
  closeWindow: procedure({ input: z.void(), output: z.custom<ActionResult>() }),
  isWindowMaximized: procedure({ input: z.void(), output: z.boolean() }),
  getAppVersion: procedure({ input: z.void(), output: z.string() }),
  getElectronVersion: procedure({ input: z.void(), output: z.string() }),
  getPlatform: procedure({ input: z.void(), output: z.custom<NodePlatform>() }),
  getPlatformDisplayName: procedure({ input: z.void(), output: z.string() }),
  getDiagnosticLogAttachment: procedure({
    input: z.void(),
    output: z.object({
      filename: z.string(),
      mimeType: z.literal('text/plain'),
      content: z.string(),
    }),
  }),
  submitFeedback: procedure({
    input: z.object({
      content: z.string(),
      files: z.array(
        z.object({
          filename: z.string(),
          mimeType: z.string(),
          bytes: z.custom<Uint8Array>(),
        })
      ),
    }),
    output: z.custom<ActionResult>(),
  }),
  events: eventStream({ key: z.void(), event: z.custom<DesktopHostEvent>() }),
});
