import type { BrowserWindow, Input, Point } from 'electron';

/**
 * Zoom steps, as in Chrome: each shortcut, menu item or wheel notch moves to the next one. Chromium
 * remembers the zoom of the renderer's origin across launches, so it is never stored here.
 */
export const ZOOM_FACTORS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

export type ZoomCommand = 'in' | 'out' | 'reset';

/** Zoom factors read back from Chromium are not exact. */
const EPSILON = 0.001;

/** `--toolbar-height` in the renderer, in CSS pixels. */
const TOOLBAR_HEIGHT = 52;
/** The macOS traffic lights: inset from the left edge, and height. They never zoom. */
const TRAFFIC_LIGHTS = { x: 16, height: 16 } as const;

/**
 * The zoom shortcut `input` is, if any: Ctrl (⌘ on macOS) with +, = (zoom in without Shift), - or 0,
 * keypad included. Matching the character typed rather than the key's position, as menu
 * accelerators do, makes them work on every keyboard layout (on AZERTY, - is the 6 key and 0 is à).
 */
export function zoomCommand(
  input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt'>,
  platform: NodeJS.Platform,
): ZoomCommand | null {
  const command =
    platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  // Windows reports AltGr as Ctrl+Alt: AltGr combinations type characters, they are not shortcuts.
  if (input.type !== 'keyDown' || !command || input.alt) {
    return null;
  }
  if (input.key === '+' || input.key === '=') {
    return 'in';
  }
  if (input.key === '-') {
    return 'out';
  }
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') {
    return 'reset';
  }
  return null;
}

/** The zoom factor after `command`, from `current`, which may lie between two steps. */
export function nextZoomFactor(current: number, command: ZoomCommand): number {
  switch (command) {
    case 'reset':
      return 1;
    case 'in':
      return ZOOM_FACTORS.find((factor) => factor > current + EPSILON) ?? ZOOM_FACTORS.at(-1) ?? 1;
    case 'out':
      return ZOOM_FACTORS.findLast((factor) => factor < current - EPSILON) ?? ZOOM_FACTORS[0];
  }
}

/** Where the macOS traffic lights sit to stay centred in the toolbar, which zooms. */
export function trafficLightPosition(factor: number): Point {
  return {
    x: TRAFFIC_LIGHTS.x,
    y: Math.round((TOOLBAR_HEIGHT * factor - TRAFFIC_LIGHTS.height) / 2),
  };
}

export function zoom(window: BrowserWindow, command: ZoomCommand): void {
  const { webContents } = window;
  webContents.setZoomFactor(nextZoomFactor(webContents.getZoomFactor(), command));
  fitTitleBar(window);
}

/**
 * Zoom shortcuts on any keyboard layout, and Ctrl + mouse wheel, which Electron leaves to apps.
 * Chromium sends no wheel zoom on macOS, where ⌘ + wheel scrolls, as in Chrome.
 */
export function handleZoom(window: BrowserWindow): void {
  const { webContents } = window;
  webContents.on('before-input-event', (event, input) => {
    const command = zoomCommand(input, process.platform);
    if (command !== null) {
      // Also keeps the menu's accelerator from zooming a second time.
      event.preventDefault();
      zoom(window, command);
    }
  });
  webContents.on('zoom-changed', (_event, direction) => {
    zoom(window, direction);
  });
  // A new document starts with the remembered zoom, but without `--zoom`.
  webContents.on('dom-ready', () => {
    fitTitleBar(window);
  });
}

/**
 * On macOS, the toolbar doubles as the title bar: the traffic lights move down as it grows, and the
 * renderer is given the zoom (`--zoom`) to keep the room it leaves them the same width on screen.
 */
function fitTitleBar(window: BrowserWindow): void {
  if (process.platform !== 'darwin') {
    return;
  }
  const factor = window.webContents.getZoomFactor();
  window.setWindowButtonPosition(trafficLightPosition(factor));
  void window.webContents
    .executeJavaScript(`document.documentElement.style.setProperty('--zoom', '${String(factor)}')`)
    .catch(() => undefined);
}
