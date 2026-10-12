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
  readonly listRoots: () => readonly LibraryRoot[];
  readonly addRoot: (path: string) => LibraryRoot;
  readonly removeRoot: (id: number) => void;
  readonly getSettings: () => Settings;
  readonly updateSettings: (patch: Partial<Settings>) => Settings;
  readonly getStatus: () => IndexStatus;
  readonly getDiagnostics: () => Diagnostics;
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
  readonly shutdown: () => void;
}

/** Control message (main → worker) that carries a fresh renderer MessagePort. */
export const RENDERER_PORT_MESSAGE = 'sg-tag:renderer-port';
