/**
 * Sandboxed preload: exposes `window.sgTag` and forwards the indexer's MessagePort to the page.
 * MessagePorts cannot cross `contextBridge`, so they travel via `window.postMessage`.
 */
import type { DesktopBridge } from '@shared/desktop-api';
import { IpcChannel, WORKER_PORT_MESSAGE } from '@shared/desktop-api';
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on(IpcChannel.workerPort, (event) => {
  window.postMessage(WORKER_PORT_MESSAGE, window.location.origin, [...event.ports]);
});

const bridge: DesktopBridge = {
  platform: process.platform,
  requestWorkerPort: () => {
    ipcRenderer.send(IpcChannel.requestWorkerPort);
  },
  pickFolder: () => ipcRenderer.invoke(IpcChannel.pickFolder) as Promise<string | null>,
  openFile: (id) => ipcRenderer.invoke(IpcChannel.openFile, id) as Promise<void>,
  revealFile: (id) => ipcRenderer.invoke(IpcChannel.revealFile, id) as Promise<void>,
  trashFile: (id) => ipcRenderer.invoke(IpcChannel.trashFile, id) as Promise<void>,
};

contextBridge.exposeInMainWorld('sgTag', bridge);
