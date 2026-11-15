/** Domain types exchanged between the indexer worker, the main process and the renderer. */

import type { TagNameProblem } from './tag-names';

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
  /** The tag's name, as typed when it was made or renamed. Aliases are in `Tag.aliases`. */
  readonly name: string;
}

/**
 * A tag: one name, any number of aliases (other names it answers to), and any number of parent
 * tags. Searching a tag also finds the files of the tags below it, at any depth.
 */
export interface Tag extends TagRef {
  /** In the order `list()` sorts names. A name or an alias resolves to exactly one tag. */
  readonly aliases: readonly string[];
  /** Its parent tags, one step up. */
  readonly parentIds: readonly number[];
  /**
   * Files that carry the tag itself, present or missing from disk; the files of the tags below it
   * are not counted.
   */
  readonly fileCount: number;
}

/** A tag as used within a selection of files. */
export interface TagUsage extends TagRef {
  readonly fileCount: number;
}

/** What a tag stands for in the library, worked out for one tag when it is edited or deleted. */
export interface TagDetails {
  readonly tag: Tag;
  readonly parents: readonly TagRef[];
  /** Its child tags, one step down. */
  readonly children: readonly TagRef[];
  /** Tags below it, at any depth. */
  readonly tagsBelow: number;
  /**
   * Files on disk that carry the tag itself: what `tag:=Name` lists. A search ignores accents, so
   * it lists more when another tag has a name or an alias that differs from this one's only by
   * them; the same goes for `filesWithBelow`.
   */
  readonly ownFiles: number;
  /** Files on disk that carry it or a tag below it, each once: what `tag:Name` lists. */
  readonly filesWithBelow: number;
  /** Files that carry the tag itself, missing ones included: what deleting it takes the tag from. */
  readonly taggedFiles: number;
  /**
   * Of `taggedFiles`, those missing from disk that have no other tag: they are kept for their tags
   * only, so deleting the tag forgets them.
   */
  readonly forgottenFiles: number;
}

/** What merging one tag into another would do, read before asking to confirm it. */
export interface TagMergePreview {
  /** The tag that would go: its files, parent tags, child tags, name and aliases move. */
  readonly from: TagRef;
  /** The tag that would stay, and get them. */
  readonly into: TagRef;
  /** Files, missing ones included, that carry `from` and not `into`: they would gain `into`. */
  readonly filesMoved: number;
  /** Files that carry both: they keep `into`, once. */
  readonly filesWithBoth: number;
  /** The aliases of `from`, sorted by name: with its name, they become aliases of `into`. */
  readonly aliases: readonly string[];
  /** Parent tags of `from`, other than `into`: they become parent tags of `into`. */
  readonly parents: number;
  /** Child tags of `from`, other than `into`: they become child tags of `into`. */
  readonly children: number;
  /** Why the merge would be refused (`loop` or `limit`); `null` when it would be made. */
  readonly refusal: TagEditError | null;
}

/** What became of one name given to `addTags`. */
export type TagAddOutcome =
  /**
   * `added`: at least one file gained the tag. `present`: no file gained it: every file had it
   * already, or none of the files exists any more (a tag made for the name then does not stay).
   */
  | { readonly name: string; readonly status: 'added' | 'present'; readonly tag: TagRef }
  | { readonly name: string; readonly status: 'refused'; readonly problem: TagNameProblem };

/** Why a change to a tag was not made. Nothing was changed. */
export type TagEditError =
  /** The tag no longer exists: deleted or merged meanwhile. */
  | { readonly kind: 'gone' }
  /** A tags export is being written or a tags import applied: tags cannot be edited meanwhile. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'invalid'; readonly problem: TagNameProblem }
  /** The name is the name (or, with `asAlias`, an alias) of `owner`, another tag. */
  | { readonly kind: 'taken'; readonly owner: TagRef; readonly asAlias: boolean }
  /**
   * `below` is already below `above` (through `through`, or directly when it is `null`), so the
   * change would put a tag below itself. `above` and `below` are the same tag when a tag was given
   * itself as a parent.
   */
  | {
      readonly kind: 'loop';
      readonly above: TagRef;
      readonly below: TagRef;
      readonly through: TagRef | null;
    }
  /**
   * A tag would have more aliases or parent tags than a tag may: the tag changed or, when a tag is
   * deleted, one of its child tags.
   */
  | { readonly kind: 'limit'; readonly what: 'aliases' | 'parents' };

/** The tag as it is after a change, or why the change was not made. */
export type TagEditResult =
  { readonly ok: true; readonly tag: Tag } | { readonly ok: false; readonly error: TagEditError };

export type TagDeleteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: TagEditError };

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
  /** Tags the file holds: those of its files, and those written with their aliases and parents. */
  readonly tags: number;
  /**
   * Of `tags`, those written with their aliases and parent tags: every tag made or edited on
   * purpose, whether or not a file has it.
   */
  readonly definitions: number;
  /**
   * Distinct tags left out of at least one file: a tags export holds 1,000 tags of a file at most,
   * the first in the order of their names.
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

/** What tags are imported from: a tags export, a TagStudio library or a classification catalogue. */
export type TagImportKind = 'tags' | 'tagStudio' | 'catalogue';

/** A name of a TagStudio tag or alias, and the name it is imported as. */
export interface TagStudioRename {
  readonly from: string;
  /** `null` when no name could be made of it: it is left out. */
  readonly to: string | null;
  /**
   * `characters`: it held what a name here cannot (a comma, a double quote, a leading `=`, a
   * control character); `sameName`: another tag had its name, with other parent tags.
   */
  readonly why: 'characters' | 'sameName';
}

/** What a TagStudio library holds that SG Tag has no place for, counted. */
export interface TagStudioLeftOut {
  /** Tags with a colour. */
  readonly colors: number;
  /** Tags with an icon. */
  readonly icons: number;
  /** Tags marked as categories. */
  readonly categories: number;
  /** Tags hidden from TagStudio's searches: they come over as ordinary tags. */
  readonly hidden: number;
  /** Fields of files: titles, notes, dates… */
  readonly fields: number;
  /** Built-in tags that come over only when used (Archived, Favorite), and Meta Tags. */
  readonly builtIn: number;
  /** Rows pointing at a tag or a file that is not there. */
  readonly broken: number;
  /** Tagged files of other folders than the library's first: a library has only one. */
  readonly otherFolders: number;
}

/** What the preview says of a TagStudio library, besides what any import says. */
export interface TagStudioDetails {
  /** Version of its database. */
  readonly version: number;
  readonly renamed: number;
  /** The first names imported as other names, or left out. */
  readonly renamedItems: readonly TagStudioRename[];
  readonly leftOut: TagStudioLeftOut;
}

/**
 * A tags export, or a TagStudio library, read for import: nothing is written until a preview of it
 * is applied.
 */
export interface TagImportSource {
  /** Identifies the open tags export for `planTagImport` and `applyTagImport`. */
  readonly token: string;
  readonly kind: TagImportKind;
  /** Name of the file, or path of the TagStudio library's folder, for display. */
  readonly name: string;
  /** When it was exported (ISO 8601), if it says so. */
  readonly exportedAt: string | null;
  /** `process.platform` of the computer it was exported from, if it says so. */
  readonly platform: string | null;
  /** Tagged files it lists that can be read: none when it only describes tags. */
  readonly files: number;
  /**
   * Distinct tags: those it describes, and those of its files. Names that differ only in letter
   * case, or by characters nobody sees, are one tag, and so are a name and its aliases.
   */
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
  /** For a TagStudio library; `null` otherwise. */
  readonly tagStudio: TagStudioDetails | null;
  /** For a classification catalogue; `null` otherwise. */
  readonly catalogue: CatalogueImportDetails | null;
}

/** Why a file of a tags export, or of a TagStudio library, was not found in this library. */
export type TagImportMissReason =
  /** It was already missing from disk when the tags export was made. */
  | 'missing'
  /** Files of its size could not be compared: on a drive that is not connected, or unreadable. */
  | 'uncompared'
  /**
   * None of its library folder's files were found here: that folder is not in this library. For a
   * TagStudio library: the file is outside the library folders.
   */
  | 'folder'
  /** TagStudio: not at its place, and several files of the library folder have its name. */
  | 'ambiguous'
  /** TagStudio: SG Tag does not index files of its kind (only images and videos). */
  | 'notMedia'
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

/** An alias that a tags import gives a tag, by their names. */
export interface TagImportAlias {
  readonly tag: string;
  readonly alias: string;
}

/** A parent link that a tags import adds, by the names of the two tags. */
export interface TagImportLink {
  readonly tag: string;
  readonly parent: string;
}

/** A link a tags import adds, and what it changes for the searches of the parent tag. */
export interface TagImportLinkItem extends TagImportLink {
  /**
   * Files of `tag` and of the tags below it that a search for `parent` does not find yet, missing
   * ones left out; `null` when `tag` is made by the import and has no file yet.
   */
  readonly newlyFound: number | null;
}

/** A tag of a tags export that is known here under another name, which gets its name as an alias. */
export interface TagImportKnownAs {
  /** Its name in the tags export. */
  readonly exported: string;
  /** Its name here. */
  readonly tag: string;
}

/** Part of what a tags export says of a tag that importing it leaves out, and why. */
export type TagImportSkip =
  /** Another tag here, `owner`, has that name. */
  | {
      readonly kind: 'aliasTaken';
      readonly tag: string;
      readonly alias: string;
      readonly owner: string;
    }
  /** The tag would have more aliases than a tag may. */
  | { readonly kind: 'aliasLimit'; readonly tag: string; readonly alias: string }
  /** The parent tag is the tag itself, or would be below it. */
  | { readonly kind: 'loop'; readonly tag: string; readonly parent: string }
  /** The tag would have more parent tags than a tag may. */
  | { readonly kind: 'parentLimit'; readonly tag: string; readonly parent: string };

/** What importing the tags that a tags export describes (aliases, parent tags) adds. */
export interface TagDefinitionCounts {
  /** Tags made, whether or not a file gets them. */
  readonly created: number;
  /** Aliases given to tags. */
  readonly aliases: number;
  /** Parent links added. */
  readonly links: number;
  /** Aliases and links left out (`TagImportSkip`). */
  readonly skipped: number;
}

/** What importing the tags that a tags export describes would add, with the first of each. */
export interface TagImportDefinitions extends TagDefinitionCounts {
  /** Names of the first tags made. */
  readonly createdItems: readonly string[];
  readonly aliasItems: readonly TagImportAlias[];
  readonly linkItems: readonly TagImportLinkItem[];
  /** Tags of the tags export known here under another name. */
  readonly knownAs: number;
  readonly knownAsItems: readonly TagImportKnownAs[];
  readonly skippedItems: readonly TagImportSkip[];
}

/** What applying a tags import adds to files. */
export interface TagImportAdditions {
  /** Tags added, counted once per file. */
  readonly assignments: number;
  /** Files that gain at least one tag. */
  readonly files: number;
  /**
   * Of the tags added, those that do not exist yet, each once: their names in the tags export are
   * neither the name nor an alias of a tag here. Tags the tags export describes are counted in
   * `TagDefinitionCounts.created` instead, whether or not a file gets them.
   */
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
  /** What applying adds of the tags the tags export describes, with or without the changed files. */
  readonly definitions: TagImportDefinitions;
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
  /** What it added of the tags the tags export describes. */
  readonly definitions: TagDefinitionCounts;
}

export interface Settings {
  /** Target tile edge in CSS pixels; the grid stretches tiles to fill each row. */
  readonly tileSize: number;
  readonly sort: SortOrder;
  /** Width of the details sidebar, in CSS pixels. */
  readonly sidebarWidth: number;
}

/** ffmpeg or ffprobe, as the indexer found it. */
export interface MediaToolInfo {
  readonly path: string;
  /** As the tool reports it: `7.1.1`, `7.1-full_build-www.gyan.dev`…; `null` if it did not say. */
  readonly version: string | null;
  /** Shipped with SG Tag (`resources/bin`): it is updated with the app. */
  readonly bundled: boolean;
}

/**
 * The rows of a classification catalogue that an import of it includes besides the others: each
 * kind is left out unless included.
 */
export interface CatalogueFilters {
  /** Rows whose confidence in the category is low. */
  readonly lowConfidence: boolean;
  /** Rows marked for further review. */
  readonly flagged: boolean;
  /** Rows of the category "Needs context or audio review", which says the subject is unclear. */
  readonly unclear: boolean;
}

/** A format tag of a classification catalogue that no tag of the library has, and its files. */
export interface CatalogueFormatItem {
  readonly name: string;
  /** Files of the rows imported that have it. */
  readonly files: number;
}

/** What the preview says of a classification catalogue, besides what any import says. */
export interface CatalogueImportDetails {
  readonly filters: CatalogueFilters;
  /** Rows read: one per file it classifies. */
  readonly rows: number;
  /** Rows of each kind that the filters may leave out, whether they do or not; a row may be several. */
  readonly matching: Readonly<Record<keyof CatalogueFilters, number>>;
  /** Rows the filters leave out. */
  readonly leftOut: number;
  /** Labels rewritten to be tag names (a comma, a double quote…), each time one is read. */
  readonly renamed: number;
  /**
   * Format tags of the rows imported that no tag of the library has, by name or alias: the import
   * makes no format tag, so they are left out.
   */
  readonly formatsWithoutTag: number;
  /** Files of the rows imported that have at least one of them. */
  readonly filesWithoutFormat: number;
  /** The most frequent of them, most files first. */
  readonly formatItems: readonly CatalogueFormatItem[];
}

/** The classification catalogue chosen in Settings, as the indexer last read it. */
export interface CatalogueStatus {
  /** The file chosen. */
  readonly path: string;
  /** Rows read: one per file it classifies. 0 while it cannot be read. */
  readonly rows: number;
  /** Rows that could not be read: left out. */
  readonly invalid: number;
  /**
   * Why, for the first few (`Row 12: no source path.`), counting rows as a spreadsheet shows them,
   * the header being row 1; never quotes the file.
   */
  readonly problems: readonly string[];
  /** Why it cannot be read now (moved, deleted, changed into something else); `null` when it can. */
  readonly error: string | null;
}

/** A tag that the classification catalogue suggests for a file. */
export interface CatalogueSuggestion {
  /** The tag's name, as the catalogue writes it once made a valid name. */
  readonly name: string;
  /** `subject`: the subcategory, below its category; `format`: a format tag. */
  readonly kind: 'subject' | 'format';
  /** The file has the tag that this is the name or an alias of. */
  readonly added: boolean;
}

/** What the classification catalogue says of one file. */
export interface CatalogueEntry {
  readonly category: string;
  readonly subcategory: string;
  /** As the catalogue writes it (`high`, `medium`, `low`); `null` when it says nothing. */
  readonly confidence: string | null;
  /** Marked for further review. */
  readonly flagged: boolean;
  readonly reviewStatus: string | null;
  readonly topic: string | null;
  readonly visibleContent: string | null;
  readonly reviewNotes: string | null;
  /**
   * How the file was found: at the path the catalogue lists (`samePlace`), there with another size
   * or date (`changed`), or elsewhere by its name, size and date (`moved`).
   */
  readonly found: 'samePlace' | 'changed' | 'moved';
  /** Where the file was when it was classified, as the catalogue writes it. */
  readonly classifiedPath: string;
  /** The subcategory first, then the format tags. */
  readonly suggestions: readonly CatalogueSuggestion[];
}

export interface Diagnostics {
  readonly appVersion: string;
  /** `null` when not found. */
  readonly ffmpeg: MediaToolInfo | null;
  /** `null` when not found. */
  readonly ffprobe: MediaToolInfo | null;
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
