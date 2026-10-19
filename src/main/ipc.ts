import { IpcChannel } from '@shared/desktop-api';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { exportFileName, exportTags, TAGS_EXPORT_FILTER } from './tag-transfer';
import { trashFile } from './trash';
import type { WorkerHost } from './worker-host';

/**
 * Main-process services for the renderer: folder picker, open/reveal/trash files, tags export and
 * import, worker port. A tags export must stay out of `dataDir`, the indexer's data folder.
 */
export function registerIpc(worker: WorkerHost, trustedOrigin: string, dataDir: string): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url;
    return url !== undefined && new URL(url).origin === trustedOrigin;
  };

  const ownerOf = (event: IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender);

  const isFileId = (id: unknown): id is number =>
    typeof id === 'number' && Number.isSafeInteger(id);

  const resolvePath = async (event: IpcMainInvokeEvent, id: unknown): Promise<string | null> => {
    if (!trusted(event) || !isFileId(id)) {
      return null;
    }
    return worker.call('resolvePath', id);
  };

  // Where the tags dialogs open next, remembered for this session only.
  let exportFolder: string | undefined;
  let importFile: string | undefined;

  ipcMain.on(IpcChannel.requestWorkerPort, (event) => {
    if (trusted(event)) {
      worker.connect(event.sender);
    }
  });

  ipcMain.handle(IpcChannel.pickFolder, async (event) => {
    if (!trusted(event)) {
      return null;
    }
    const options: Electron.OpenDialogOptions = {
      title: 'Add a library folder',
      buttonLabel: 'Add Folder',
      properties: ['openDirectory'],
    };
    const owner = ownerOf(event);
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IpcChannel.openFile, async (event, id: unknown) => {
    const filePath = await resolvePath(event, id);
    if (filePath !== null) {
      const error = await shell.openPath(filePath);
      if (error !== '') {
        throw new Error(error);
      }
    }
  });

  ipcMain.handle(IpcChannel.revealFile, async (event, id: unknown) => {
    const filePath = await resolvePath(event, id);
    if (filePath !== null) {
      shell.showItemInFolder(filePath);
    }
  });

  ipcMain.handle(IpcChannel.trashFile, async (event, id: unknown) => {
    if (trusted(event) && isFileId(id)) {
      await trashFile(worker, id, (filePath) => shell.trashItem(filePath));
    }
  });

  ipcMain.handle(IpcChannel.exportTags, async (event) => {
    if (!trusted(event)) {
      return null;
    }
    const options: Electron.SaveDialogOptions = {
      title: 'Export tags',
      buttonLabel: 'Export',
      defaultPath: path.join(exportFolder ?? app.getPath('documents'), exportFileName(new Date())),
      filters: [TAGS_EXPORT_FILTER],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const owner = ownerOf(event);
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || result.filePath === '') {
      return null;
    }
    const exported = await exportTags(worker, result.filePath, {
      appVersion: app.getVersion(),
      dataDir,
    });
    exportFolder = path.dirname(result.filePath);
    return exported;
  });

  ipcMain.handle(IpcChannel.openTagImport, async (event) => {
    if (!trusted(event)) {
      return null;
    }
    const options: Electron.OpenDialogOptions = {
      title: 'Import tags',
      buttonLabel: 'Open',
      // After adding a folder or connecting a drive, the same tags export is one Enter away.
      defaultPath: importFile ?? app.getPath('documents'),
      filters: [TAGS_EXPORT_FILTER, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    };
    const owner = ownerOf(event);
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const filePath = result.canceled ? undefined : result.filePaths[0];
    if (filePath === undefined) {
      return null;
    }
    const source = await worker.call('openTagImport', filePath);
    importFile = filePath;
    return source;
  });
}
