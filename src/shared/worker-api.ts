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
  TagAddOutcome,
  TagDeleteResult,
  TagDetails,
  TagEditResult,
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
  /**
   * Tags `fileIds` with each of `names`: a name or an alias is that of its tag, and an unknown name
   * makes a tag. Answers for each name, in order; a refused name tags nothing.
   */
  readonly addTags: (
    fileIds: readonly number[],
    names: readonly string[],
  ) => readonly TagAddOutcome[];
  /**
   * Takes the tags from the files. A tag made only by tagging files goes with its last file; one
   * made or edited on purpose stays until `deleteTag`.
   */
  readonly removeTags: (fileIds: readonly number[], tagIds: readonly number[]) => void;
  /** Makes a tag that no file has yet. `taken` when the name is one of an existing tag. */
  readonly createTag: (name: string) => TagEditResult;
  /**
   * Renames a tag. A change of letter case only, or of characters nobody sees, is a rename; one of
   * its own aliases becomes the name and the old name an alias; otherwise the old name stays as an
   * alias only with `keepOldName`.
   */
  readonly renameTag: (id: number, name: string, keepOldName: boolean) => TagEditResult;
  /** Gives a tag another name. One it already has changes nothing. */
  readonly addTagAlias: (id: number, alias: string) => TagEditResult;
  readonly removeTagAlias: (id: number, alias: string) => TagEditResult;
  /**
   * Puts the tag below the tag that `parentName` names (by its name or an alias), making that tag
   * when no tag has the name. `loop` when that tag is the tag itself or below it.
   */
  readonly addTagParent: (id: number, parentName: string) => TagEditResult;
  readonly removeTagParent: (id: number, parentId: number) => TagEditResult;
  /**
   * Deletes a tag: its files lose it, its aliases go, and its child tags move up to its parent
   * tags, so that the tags above still find their files. `limit`, deleting nothing, when one of its
   * child tags would then have more parent tags than a tag may.
   */
  readonly deleteTag: (id: number) => TagDeleteResult;
  /**
   * Makes one tag of two: the files, parent tags and child tags of `fromId` become those of
   * `intoId`, and its name and aliases become aliases of `intoId`, which is answered. `loop` when
   * one is below the other with a tag in between.
   */
  readonly mergeTags: (fromId: number, intoId: number) => TagEditResult;
  /** What deleting or editing a tag is about to affect; `null` when it no longer exists. */
  readonly getTagDetails: (id: number) => TagDetails | null;
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
  /** The tags of files, or the list of tags, changed. */
  readonly tagsChanged: null;
  /**
   * Names, aliases or parent links changed, or a tag was deleted or merged: a search by tag or by
   * text may now find other files, though no file changed. Sent along with `tagsChanged`.
   */
  readonly tagDefinitionsChanged: null;
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

/**
 * Exit code of the worker when the library was made by a newer version of SG Tag: the main process
 * says so and quits instead of starting the worker again. Apart from the codes Node.js exits with
 * by itself (1 to 13, and above 128 for a signal).
 */
export const NEWER_LIBRARY_EXIT_CODE = 100;

/**
 * What the user is told of a library made by a newer version of SG Tag: the message of the worker's
 * error for it, which goes to its log, and what the main process shows before it quits.
 */
export const NEWER_LIBRARY_MESSAGE =
  'This library was made by a newer version of SG Tag. Update SG Tag to open it.';
