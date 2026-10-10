/** Domain types exchanged between the indexer worker, the main process and the renderer. */

export type FileKind = 'image' | 'video';

/** Everything a grid tile needs; kept small because thousands are fetched while scrolling. */
export interface FileSummary {
  readonly id: number;
  readonly name: string;
  readonly kind: FileKind;
  /** Display label of the format, e.g. `JPG`, `HEIC`, `MP4`. */
  readonly format: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  /** The file's root folder is unreachable right now (e.g. an unplugged drive). */
  readonly offline: boolean;
}

export interface FileDetails extends FileSummary {
  readonly path: string;
  /** Folder relative to the root, `/`-separated; empty for files at the root. */
  readonly folder: string;
  readonly rootPath: string;
  readonly birthtimeMs: number | null;
  readonly codec: string | null;
  /** The file vanished from disk but is kept because it carries tags. */
  readonly missing: boolean;
  readonly tags: readonly TagRef[];
}

export interface TagRef {
  readonly id: number;
  /** Full hierarchical path, `/`-separated, e.g. `trips/2024/japan`. */
  readonly path: string;
}

export interface Tag extends TagRef {
  readonly name: string;
  readonly parentId: number | null;
  readonly fileCount: number;
}

/** A tag as used within a selection of files. */
export interface TagUsage extends TagRef {
  readonly fileCount: number;
}

export interface LibraryRoot {
  readonly id: number;
  readonly path: string;
  readonly online: boolean;
  readonly fileCount: number;
  readonly taggedCount: number;
}

export type SortField = 'modified' | 'name' | 'size';
export type SortDirection = 'asc' | 'desc';

export interface SortOrder {
  readonly field: SortField;
  readonly direction: SortDirection;
}

export interface SearchRequest {
  readonly query: string;
  readonly sort: SortOrder;
}

export interface SearchResult {
  /** Matching file ids in display order. */
  readonly ids: Int32Array;
  readonly elapsedMs: number;
}

export interface IndexStatus {
  readonly totalFiles: number;
  /** Root currently being scanned, if any. */
  readonly scanning: string | null;
  readonly pendingThumbnails: number;
  readonly offlineRoots: number;
}

export interface Settings {
  /** Target tile edge in CSS pixels; the grid stretches tiles to fill each row. */
  readonly tileSize: number;
  readonly sort: SortOrder;
}

export interface Diagnostics {
  readonly ffmpeg: string | null;
  readonly ffprobe: string | null;
  readonly sqlite: string;
  readonly dataDir: string;
}

export const TILE_SIZE = { min: 96, max: 320, step: 8 } as const;

/** Long edge of stored thumbnails, in pixels: the largest tile on a 2× display, roughly. */
export const THUMBNAIL_EDGE = 512;

export const DEFAULT_SETTINGS: Settings = {
  tileSize: 176,
  sort: { field: 'modified', direction: 'desc' },
};
