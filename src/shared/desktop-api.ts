import type { CatalogueStatus, TagExportResult, TagImportSource } from './model';

/** API the preload script exposes to the renderer as `window.sgTag`. */
export interface DesktopBridge {
  readonly platform: string;
  /** Asks the main process for a MessagePort to the indexer worker (delivered via `window.postMessage`). */
  readonly requestWorkerPort: () => void;
  readonly pickFolder: () => Promise<string | null>;
  readonly openFile: (id: number) => Promise<void>;
  readonly revealFile: (id: number) => Promise<void>;
  /** Moves a file that has an identical copy to the Trash, after giving its tags to the copy. */
  readonly trashFile: (id: number) => Promise<void>;
  /** Asks where to save, then exports the tags of every tagged file there; `null` if canceled. */
  readonly exportTags: () => Promise<TagExportResult | null>;
  /**
   * Asks for a tags export and reads it, writing nothing; `null` if canceled. Preview it with
   * `LibraryApi.planTagImport`.
   */
  readonly openTagImport: () => Promise<TagImportSource | null>;
  /**
   * Asks for the folder of a TagStudio library and reads it, writing nothing; `null` if canceled.
   * Preview it with `LibraryApi.planTagImport`.
   */
  readonly openTagStudioImport: () => Promise<TagImportSource | null>;
  /**
   * Asks for a classification catalogue (a CSV file) and uses it from then on; `null` if canceled.
   * Rejects, saying why, when the file cannot be used.
   */
  readonly chooseCatalogue: () => Promise<CatalogueStatus | null>;
  /** The newest FFmpeg release that ffmpeg.org lists, e.g. `9.0.2`; asks ffmpeg.org each time. */
  readonly latestFfmpegRelease: () => Promise<string>;
}

export const IpcChannel = {
  requestWorkerPort: 'worker:request-port',
  workerPort: 'worker:port',
  pickFolder: 'dialog:pick-folder',
  openFile: 'shell:open-file',
  revealFile: 'shell:reveal-file',
  trashFile: 'shell:trash-file',
  exportTags: 'tags:export',
  openTagImport: 'tags:open-import',
  openTagStudioImport: 'tags:open-tagstudio-import',
  chooseCatalogue: 'catalogue:choose',
  latestFfmpegRelease: 'updates:latest-ffmpeg',
} as const;

/** `window.postMessage` payload used by the preload script to hand the worker port to the page. */
export const WORKER_PORT_MESSAGE = 'sg-tag:worker-port';
