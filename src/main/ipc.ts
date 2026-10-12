import { IpcChannel } from '@shared/desktop-api';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { WorkerHost } from './worker-host';

/** Main-process services for the renderer: folder picker, open/reveal/trash files, worker port. */
export function registerIpc(worker: WorkerHost, trustedOrigin: string): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url;
    return url !== undefined && new URL(url).origin === trustedOrigin;
  };

  const isFileId = (id: unknown): id is number =>
    typeof id === 'number' && Number.isSafeInteger(id);

  const resolvePath = async (event: IpcMainInvokeEvent, id: unknown): Promise<string | null> => {
    if (!trusted(event) || !isFileId(id)) {
      return null;
    }
    return worker.call('resolvePath', id);
  };

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
    const owner = BrowserWindow.fromWebContents(event.sender);
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

  // Only a file the indexer vouches for: an identical copy stays on disk and has its tags.
  ipcMain.handle(IpcChannel.trashFile, async (event, id: unknown) => {
    if (!trusted(event) || !isFileId(id)) {
      return;
    }
    const filePath = await worker.call('prepareTrash', id);
    try {
      await shell.trashItem(filePath);
    } finally {
      // Also when trashing failed: the indexer stops expecting the file to vanish.
      await worker.call('forgetFile', id);
    }
  });
}
