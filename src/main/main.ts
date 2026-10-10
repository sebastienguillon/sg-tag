import { createLogger } from '@shared/log';
import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { APP_ORIGIN, contentSecurityPolicy, handleProtocols, registerSchemes } from './protocols';
import { createMainWindow } from './window';
import { WorkerHost } from './worker-host';

const log = createLogger('main');

/** Set by `pnpm dev`: load the renderer from the Angular dev server instead of the bundle. */
const devServer = process.env['SG_TAG_DEV_SERVER_URL'] ?? null;
const rendererUrl = devServer ?? `${APP_ORIGIN}/`;

/** Separate profile (database, thumbnails, window state), e.g. for development or tests. */
const userDataOverride = process.env['SG_TAG_USER_DATA'];
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', path.resolve(userDataOverride));
}

registerSchemes();

if (app.requestSingleInstanceLock()) {
  main().catch((error: unknown) => {
    log.error('Startup failed:', error);
    app.exit(1);
  });
} else {
  app.quit();
}

async function main(): Promise<void> {
  await app.whenReady();

  const worker = new WorkerHost({
    entry: path.join(import.meta.dirname, 'worker.js'),
    dataDir: app.getPath('userData'),
    resourcesDir: process.resourcesPath,
  });
  worker.start();

  handleProtocols(worker, path.join(app.getAppPath(), 'dist', 'renderer', 'browser'));
  registerIpc(worker, new URL(rendererUrl).origin);
  hardenSession();

  const openWindow = (): BrowserWindow =>
    createMainWindow({ url: rendererUrl, preload: path.join(import.meta.dirname, 'preload.cjs') });
  let window = openWindow();

  app.on('second-instance', () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      window = openWindow();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let stopped = false;
  app.on('before-quit', (event) => {
    if (stopped) {
      return;
    }
    // Let the indexer close its database cleanly before exiting.
    event.preventDefault();
    stopped = true;
    void worker.stop().finally(() => {
      app.quit();
    });
  });
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (devServer !== null) {
    // In production the `app:` protocol handler sets the CSP; here the dev server's responses need it.
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${devServer}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [contentSecurityPolicy(devServer)],
          },
        });
      },
    );
  }
}
