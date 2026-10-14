import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, type Rectangle } from 'electron';
import { desktopHostEvents } from '@core/features/workbench/node';
import type {
  PopoutReturn,
  PopoutWindowRecord,
} from '@core/primitives/desktop-host/api/host-contract';
import { isShutdownInProgress } from '@main/bootstrap/shutdown';
import { registerExternalLinkHandlers } from '@main/host/externalLinks';
import { log } from '@main/lib/logger';
import { APP_ORIGIN } from './protocol';

/** The query a pop-out window's page carries: which record it shows. */
export const POPOUT_WINDOW_QUERY = 'popout';

type StoredState = { windows: PopoutWindowRecord[]; returns: PopoutReturn[] };

const windows = new Map<string, BrowserWindow>();
let state: StoredState | null = null;
let writeChain: Promise<void> = Promise.resolve();

function stateFile(): string {
  return join(app.getPath('userData'), 'popout-windows.json');
}

function load(): StoredState {
  if (state) return state;
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<StoredState>;
    state = {
      windows: Array.isArray(parsed.windows) ? parsed.windows : [],
      returns: Array.isArray(parsed.returns) ? parsed.returns : [],
    };
  } catch {
    state = { windows: [], returns: [] };
  }
  return state;
}

/** Writes are queued so a burst of layout updates lands in order. */
function save(): void {
  const text = JSON.stringify(load());
  const file = stateFile();
  writeChain = writeChain
    .then(async () => {
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, text);
      await rename(temp, file);
    })
    .catch((error: unknown) => log.warn('popout windows: could not save', { error }));
}

function record(id: string): PopoutWindowRecord | undefined {
  return load().windows.find((item) => item.id === id);
}

/** The pop-out a window shows, if it is one. */
export function popoutIdOfWindow(window: BrowserWindow | null | undefined): string | null {
  if (!window) return null;
  for (const [id, candidate] of windows) if (candidate === window) return id;
  return null;
}

export function getPopoutWindow(id: string): PopoutWindowRecord | null {
  return record(id) ?? null;
}

export function openPopoutWindow(
  input: Omit<PopoutWindowRecord, 'id' | 'alwaysOnTop' | 'bounds'> & {
    position?: { x: number; y: number };
  }
): { id: string } {
  const { position, ...rest } = input;
  const item: PopoutWindowRecord = {
    ...rest,
    id: randomUUID(),
    alwaysOnTop: false,
    // A dropped tab: the window opens with its title bar under the pointer.
    ...(position && {
      bounds: {
        x: Math.round(position.x - 120),
        y: Math.round(position.y - 16),
        width: 900,
        height: 700,
      },
    }),
  };
  load().windows.push(item);
  save();
  createWindow(item);
  return { id: item.id };
}

export function updatePopoutWindow(input: { id: string; layout?: unknown; title?: string }): void {
  const item = record(input.id);
  if (!item) return;
  if (input.layout !== undefined) item.layout = input.layout;
  if (input.title !== undefined) {
    item.title = input.title;
    windows.get(input.id)?.setTitle(input.title);
  }
  save();
}

export function setPopoutAlwaysOnTop(input: { id: string; alwaysOnTop: boolean }): void {
  const item = record(input.id);
  if (!item) return;
  item.alwaysOnTop = input.alwaysOnTop;
  windows.get(input.id)?.setAlwaysOnTop(input.alwaysOnTop, 'floating');
  save();
}

/**
 * Hands the window's tabs back to the main window and closes it. The return is queued
 * until the main window takes it, so tabs survive a main window that is not listening.
 */
export function returnPopoutWindow(input: { id: string }): void {
  const window = windows.get(input.id);
  handBack(input.id);
  if (window && !window.isDestroyed()) window.destroy();
}

function handBack(id: string): void {
  const item = record(id);
  windows.delete(id);
  if (!item) return;
  const current = load();
  current.windows = current.windows.filter((candidate) => candidate.id !== id);
  current.returns.push({
    projectId: item.projectId,
    taskId: item.taskId,
    layout: item.layout,
    originPaneId: item.originPaneId,
  });
  save();
  desktopHostEvents.emit(undefined, { type: 'popout-returns-pending' });
}

/** Queues some of a pop-out's tabs for the main window; the pop-out stays open. */
export function returnPopoutTabs(input: { id: string; layout: unknown }): void {
  const item = record(input.id);
  if (!item) return;
  load().returns.push({
    projectId: item.projectId,
    taskId: item.taskId,
    layout: input.layout,
    originPaneId: item.originPaneId,
  });
  save();
  desktopHostEvents.emit(undefined, { type: 'popout-returns-pending' });
}

export function takePopoutReturns(): PopoutReturn[] {
  const current = load();
  const taken = current.returns;
  if (taken.length === 0) return [];
  current.returns = [];
  save();
  return taken;
}

/** Reopens the pop-outs that were open when the app last quit. */
export function restorePopoutWindows(): void {
  for (const item of load().windows) createWindow(item);
}

function createWindow(item: PopoutWindowRecord): void {
  const bounds = item.bounds;
  const window = new BrowserWindow({
    width: bounds?.width ?? 900,
    height: bounds?.height ?? 700,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 360,
    minHeight: 240,
    title: item.title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#fcfcfc',
    alwaysOnTop: item.alwaysOnTop,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      preload: join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
    },
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 10, y: 10 } }
      : {}),
  });
  if (item.alwaysOnTop) window.setAlwaysOnTop(true, 'floating');
  if (process.platform !== 'darwin') window.setMenuBarVisibility(false);
  windows.set(item.id, window);

  const rendererUrl = import.meta.env.DEV
    ? process.env.ELECTRON_RENDERER_URL!
    : `${APP_ORIGIN}/index.html`;
  void window.loadURL(`${rendererUrl}?${POPOUT_WINDOW_QUERY}=${encodeURIComponent(item.id)}`);
  registerExternalLinkHandlers(window, rendererUrl);
  // The page's own <title> would replace the task's name.
  window.on('page-title-updated', (event) => event.preventDefault());

  const rememberBounds = () => {
    const current = record(item.id);
    if (!current || window.isDestroyed()) return;
    const next: Rectangle = window.getNormalBounds();
    current.bounds = next;
    save();
  };
  window.on('moved', rememberBounds);
  window.on('resized', rememberBounds);

  window.on('close', () => {
    // Quitting keeps the pop-out so it reopens with the app; closing it hands its tabs
    // back to the main window.
    if (isShutdownInProgress()) return;
    if (!windows.has(item.id)) return;
    handBack(item.id);
  });
  window.on('closed', () => {
    if (windows.get(item.id) === window) windows.delete(item.id);
  });
}
