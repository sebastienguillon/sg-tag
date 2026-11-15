import { FFMPEG_DOWNLOAD_PAGE } from '@shared/ffmpeg-version';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import { handleZoom, trafficLightPosition } from './zoom';

export interface MainWindowOptions {
  readonly url: string;
  readonly preload: string;
}

/** The web pages the interface links to (`target="_blank"`): they open in the default browser. */
const EXTERNAL_PAGES: ReadonlySet<string> = new Set([FFMPEG_DOWNLOAD_PAGE]);

/** Matches the renderer's background tokens, so the window never flashes white on open. */
const BACKGROUND = { light: '#f6f6f7', dark: '#141518' } as const;

export function createMainWindow({ url, preload }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'SG Tag',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    // On macOS the toolbar doubles as the title bar.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: trafficLightPosition(1) }
      : { autoHideMenuBar: true }),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  handleZoom(window);

  const { origin } = new URL(url);
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (EXTERNAL_PAGES.has(target)) {
      void shell.openExternal(target);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
    }
  });

  void window.loadURL(url);
  return window;
}
