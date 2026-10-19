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
  /** Other files with exactly the same content, among those checked for duplicates. */
  readonly copies: readonly FileCopy[];
}

/** A file with exactly the same content as another. */
export interface FileCopy {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly offline: boolean;
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
  /** Progress of a library-wide duplicate check, while one runs. */
  readonly duplicateCheck: DuplicateCheck | null;
  /** Progress of a tags export or import, while one runs. */
  readonly tagTransfer: TagTransferProgress | null;
  /** Library folders being removed, from any window: tags cannot be exported meanwhile. */
  readonly removingFolders: number;
}

/** Files read so far by a duplicate check, out of those it knows it has to read. */
export interface DuplicateCheck {
  readonly done: number;
  readonly total: number;
}

/** What a tags export or import is doing. */
export type TagTransferStep =
  /** Writing every tagged file to a tags export (`done`/`total`: files). */
  | 'exporting'
  /** Reading a tags export chosen for import (`done`/`total`: bytes). */
  | 'reading'
  /** Waiting for indexing to finish, so that every file on disk can be found. */
  | 'waiting'
  /** Looking up the files of the tags export in the library (`done`/`total`: its files). */
  | 'matching'
  /** Reading the start and end of files to compare their content (`done`/`total`: files read). */
  | 'comparing'
  /** Adding the tags (`done`/`total`: files). */
  | 'importing';

export interface TagTransferProgress {
  readonly step: TagTransferStep;
  /** Both 0 while the amount of work is not known yet. */
  readonly done: number;
  readonly total: number;
}

/** A tags export saved where the user chose. */
export interface TagExportResult {
  /** The file chosen in the save dialog. */
  readonly path: string;
  /** Tagged files written, missing and offline ones included. */
  readonly files: number;
  /** Of `files`, those missing from disk, written for their tags. */
  readonly missing: number;
  /** Tags in the library. */
  readonly tags: number;
  /**
   * Distinct tags left out of at least one file because a tags export cannot hold them: longer
   * than its limit, nested deeper, with a long run of combining marks, or past the number a file
   * may carry.
   */
  readonly leftOut: number;
}

/** The latest tags export saved from this library. */
export interface TagExportRecord {
  /** When it was saved, in ms since the epoch. */
  readonly at: number;
  /** The file chosen in the save dialog. */
  readonly path: string;
  readonly files: number;
}

/** A tags export read for import: nothing is written until a preview of it is applied. */
export interface TagImportSource {
  /** Identifies the open tags export for `planTagImport` and `applyTagImport`. */
  readonly token: string;
  /** Name of the file, for display. */
  readonly name: string;
  /** When it was exported (ISO 8601), if it says so. */
  readonly exportedAt: string | null;
  /** `process.platform` of the computer it was exported from, if it says so. */
  readonly platform: string | null;
  /** Tagged files it lists that can be read. */
  readonly files: number;
  /** Distinct tags of those files, ancestors included. */
  readonly tags: number;
  /**
   * Lines that could not be read in full: the line is left out, or only the tags that could not be
   * read are.
   */
  readonly invalid: number;
  /**
   * Why, for the first few (`Line 12: invalid path.`, `Line 13: a tag was left out.`); never quotes
   * the file.
   */
  readonly problems: readonly string[];
}

/** Why a file of a tags export was not found in this library. */
export type TagImportMissReason =
  /** It was already missing from disk when the tags export was made. */
  | 'missing'
  /** Files of its size could not be compared: on a drive that is not connected, or unreadable. */
  | 'uncompared'
  /** None of its library folder's files were found here: that folder is not in this library. */
  | 'folder'
  | 'notFound';

/** A file of a tags export, and the file it was found as here. */
export interface TagImportItem {
  /** Its path on the computer it was exported from. */
  readonly exported: string;
  readonly current: string;
}

/** A file of a tags export that was not found. */
export interface TagImportMissedItem {
  /** Its path on the computer it was exported from. */
  readonly exported: string;
  readonly reason: TagImportMissReason;
}

/** A library folder of a tags export, and what was found of it here. */
export interface TagImportFolder {
  /** As on the computer it was exported from. */
  readonly exported: string;
  readonly files: number;
  /** Its files found here by their content (`changed` ones excluded). */
  readonly found: number;
  /** Library folders holding them, most first (at most 3). */
  readonly foundIn: readonly string[];
  /** A library folder here has the same path, whether or not its files were found. */
  readonly inLibrary: boolean;
  /**
   * A library folder here has the same path, but its files at their place mostly have other
   * content: another drive or card may be mounted there. Files at their place are not tagged.
   */
  readonly suspicious: boolean;
  /**
   * Nothing of it was found, and a folder at that very path exists on this computer and can be
   * added to the library (same kind of computer, a path on a local disk rather than a network
   * share, no overlap with a library folder).
   */
  readonly addable: boolean;
}

/** What applying a tags import adds. */
export interface TagImportAdditions {
  /** Tags added, counted once per file. */
  readonly assignments: number;
  /** Files that gain at least one tag. */
  readonly files: number;
  /** Tags that do not exist yet, ancestors included. */
  readonly newTags: number;
}

/** What importing a tags export would do. Nothing is written until it is applied. */
export interface TagImportPreview {
  /** Pass to `applyTagImport`: only the latest preview of a tags export can be applied. */
  readonly planId: number;
  /** Files of the tags export found here by their content, by how. */
  readonly found: {
    /** At the same place relative to their library folder. */
    readonly samePlace: number;
    /** Elsewhere: renamed or moved since the export. */
    readonly moved: number;
    /**
     * Found as a file another file of the tags export was found as too (identical copies): that
     * file gets the tags of each.
     */
    readonly shared: number;
  };
  /**
   * Files at the very same path, in a library folder its other files confirm, whose content
   * changed since the export or could not be compared. Tagged only if the import includes them.
   */
  readonly changed: number;
  readonly notFound: Readonly<Record<TagImportMissReason, number>>;
  /** Library folders of the tags export that list files, in export order. */
  readonly folders: readonly TagImportFolder[];
  /** Up to 100 files found elsewhere. */
  readonly movedItems: readonly TagImportItem[];
  /** Up to 100 changed files. */
  readonly changedItems: readonly TagImportItem[];
  /** Up to 500 files not found. */
  readonly missedItems: readonly TagImportMissedItem[];
  /** What applying adds without the changed files. */
  readonly additions: TagImportAdditions;
  /** What applying adds with the changed files. */
  readonly additionsWithChanged: TagImportAdditions;
}

/** What applying a tags import added. */
export interface TagImportResult extends TagImportAdditions {
  /**
   * Files that moved, changed, went missing from disk or left the library between the preview and
   * the import: left out.
   */
  readonly skipped: number;
  /** Files of the tags export not found, carried from the preview for the closing message. */
  readonly notFound: number;
}

export interface Settings {
  /** Target tile edge in CSS pixels; the grid stretches tiles to fill each row. */
  readonly tileSize: number;
  readonly sort: SortOrder;
  /** Width of the details sidebar, in CSS pixels. */
  readonly sidebarWidth: number;
}

export interface Diagnostics {
  readonly ffmpeg: string | null;
  readonly ffprobe: string | null;
  readonly sqlite: string;
  readonly dataDir: string;
}

export const TILE_SIZE = { min: 96, max: 320, step: 8 } as const;

export const SIDEBAR_WIDTH = { min: 240, max: 640, step: 16 } as const;

/** Long edge of stored thumbnails, in pixels: the largest tile on a 2× display, roughly. */
export const THUMBNAIL_EDGE = 512;

export const DEFAULT_SETTINGS: Settings = {
  tileSize: 176,
  sort: { field: 'modified', direction: 'desc' },
  sidebarWidth: 300,
};
