/** API the preload script exposes to the renderer as `window.sgTag`. */
export interface DesktopBridge {
  readonly platform: string;
  /** Asks the main process for a MessagePort to the indexer worker (delivered via `window.postMessage`). */
  readonly requestWorkerPort: () => void;
  readonly pickFolder: () => Promise<string | null>;
  readonly openFile: (id: number) => Promise<void>;
  readonly revealFile: (id: number) => Promise<void>;
}

export const IpcChannel = {
  requestWorkerPort: 'worker:request-port',
  workerPort: 'worker:port',
  pickFolder: 'dialog:pick-folder',
  openFile: 'shell:open-file',
  revealFile: 'shell:reveal-file',
} as const;

/** `window.postMessage` payload used by the preload script to hand the worker port to the page. */
export const WORKER_PORT_MESSAGE = 'sg-tag:worker-port';
