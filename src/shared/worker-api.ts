import type {
  Diagnostics,
  FileDetails,
  FileSummary,
  IndexStatus,
  LibraryRoot,
  SearchRequest,
  SearchResult,
  Settings,
  Tag,
  TagExportRecord,
  TagExportResult,
  TagImportPreview,
  TagImportResult,
  TagImportSource,
  TagUsage,
} from './model';

/** Served by the indexer worker to the renderer, over a MessagePort that bypasses the main process. */
export interface LibraryApi {
  readonly search: (request: SearchRequest) => SearchResult;
  readonly getFiles: (ids: readonly number[]) => readonly FileSummary[];
  readonly getDetails: (id: number) => FileDetails | null;
  readonly getSelectionTags: (ids: readonly number[]) => readonly TagUsage[];
  readonly listTags: () => readonly Tag[];
  readonly addTags: (fileIds: readonly number[], tagPaths: readonly string[]) => void;
  readonly removeTags: (fileIds: readonly number[], tagIds: readonly number[]) => void;
  /** Checks the whole library for identical files; resolves to how many files have a copy. */
  readonly findDuplicates: () => number;
  /** Gives a file and each of its identical copies the tags of all of them. */
  readonly shareTagsWithCopies: (fileId: number) => void;
  readonly listRoots: () => readonly LibraryRoot[];
  readonly addRoot: (path: string) => LibraryRoot;
  readonly removeRoot: (id: number) => void;
  readonly getSettings: () => Settings;
  readonly updateSettings: (patch: Partial<Settings>) => Settings;
  readonly getStatus: () => IndexStatus;
  readonly getDiagnostics: () => Diagnostics;
  /** The latest tags export saved from this library, if any. */
  readonly getLastTagExport: () => TagExportRecord | null;
  /**
   * Matches the tags export opened as `token` (`DesktopBridge.openTagImport`) against the library,
   * once indexing has settled. Adds no tags; fingerprints read on the way are kept, as the
   * background fingerprinter would. A newer call cancels one still running.
   */
  readonly planTagImport: (token: string) => TagImportPreview;
  /**
   * Adds the tags of preview `planId` (with its changed files if `includeChanged`); never removes
   * any. Throws when the preview is out of date.
   */
  readonly applyTagImport: (
    token: string,
    planId: number,
    includeChanged: boolean,
  ) => TagImportResult;
  /** Stops reading or matching a tags export and forgets it; an import being applied finishes. */
  readonly closeTagImport: () => void;
}

export interface LibraryEvents {
  readonly status: IndexStatus;
  /** Files were added, removed or changed; `ids` is `null` when the change is too broad to list. */
  readonly filesChanged: { readonly ids: readonly number[] | null };
  /** Thumbnails and media metadata (dimensions, duration) became available; results are unchanged. */
  readonly mediaChanged: { readonly ids: readonly number[] };
  readonly tagsChanged: null;
  readonly rootsChanged: null;
}

/** Where the main process should get a thumbnail from. */
export type ThumbnailSource =
  | { readonly kind: 'file'; readonly path: string }
  /** The worker cannot decode this file; render it with the OS thumbnailer (macOS/Windows). */
  | { readonly kind: 'system'; readonly sourcePath: string }
  | { readonly kind: 'none' };

/** Served by the worker to the main process, over the utility process' parent port. */
export interface WorkerHostApi {
  readonly thumbnail: (id: number) => ThumbnailSource;
  /** Stores a thumbnail rendered by the OS (PNG bytes), or records that none could be made. */
  readonly storeThumbnail: (id: number, png: Uint8Array | null) => string | null;
  readonly resolvePath: (id: number) => string | null;
  /** Path of an indexed video that is on disk, for streaming to the renderer; `null` otherwise. */
  readonly videoPath: (id: number) => string | null;
  /**
   * Before a file is moved to the Trash: checks that an identical copy of it stays on disk, adds
   * the file's tags to its copies, and returns its path. Throws when the file must not be trashed.
   */
  readonly prepareTrash: (id: number) => string;
  /**
   * After moving a file to the Trash (`trashed`) or failing to: drops it from the index if it is
   * gone; if it stays, takes back the tags its copies were given for it.
   */
  readonly forgetFile: (id: number, trashed: boolean) => void;
  /**
   * Writes every tagged file and its tags to `destination`, the file chosen in the save dialog:
   * the whole export is written in the data folder first, so a failure never leaves a file cut
   * short at `destination`. Records it as the latest export.
   */
  readonly exportTags: (destination: string, appVersion: string) => TagExportResult;
  /**
   * Reads a tags export the user chose in an open dialog and keeps it for `planTagImport`,
   * replacing any other. Throws, saying why, when it cannot be imported.
   */
  readonly openTagImport: (filePath: string) => TagImportSource;
  readonly shutdown: () => void;
}

/** Control message (main → worker) that carries a fresh renderer MessagePort. */
export const RENDERER_PORT_MESSAGE = 'sg-tag:renderer-port';
