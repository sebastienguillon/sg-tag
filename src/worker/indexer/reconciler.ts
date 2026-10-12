import type { FileRecord, FilesRepository, IndexedFile } from '../library/files-repository';
import { formatOf } from '../library/formats';
import { splitPath } from '../library/paths';
import type { RootRecord } from '../library/roots-repository';
import type { DiskFile } from './crawler';
import { statFile } from './crawler';
import { fingerprint } from './fingerprint';

/**
 * How long a vanished file may still turn out to have moved. Untagged files that vanish are kept as
 * missing this long before being forgotten, and a file added this recently may be the new location
 * of a file that vanishes after it: a copy made before its source was deleted (a move to another
 * drive, or between library folders, whose watchers report in no particular order).
 */
export const MOVE_WINDOW_MS = 30 * 60_000;

export interface ChangeSet {
  /** Files created, updated, relocated or marked missing. */
  readonly changed: readonly number[];
  /** Files whose rows were deleted. */
  readonly deleted: readonly number[];
}

interface Upsert {
  readonly disk: DiskFile;
  readonly known: IndexedFile | undefined;
}

const NO_CHANGES: ChangeSet = { changed: [], deleted: [] };

/**
 * Applies what is on disk to the index, preserving file identity across renames and moves done
 * outside the app. A file is the same as another when both have the same size and either the same
 * device+inode and mtime (same volume) or the same content fingerprint (another volume). It then
 * keeps its id, tags and thumbnail.
 *
 * - A file that disappears is kept as "missing": tagged files until they reappear, untagged ones for
 *   `MOVE_WINDOW_MS` (see `sweep`). A file found at a new path is matched against them.
 * - A file that disappears is also matched against files added in the last `MOVE_WINDOW_MS`, for
 *   moves whose new path was seen first.
 */
export class Reconciler {
  private readonly files: FilesRepository;
  /** Files the app is deleting itself: when they vanish, they are gone, not moved. */
  private readonly expected = new Set<number>();

  constructor(files: FilesRepository) {
    this.files = files;
  }

  /** Brings the index for `root` in line with a complete crawl of it. */
  async syncRoot(root: RootRecord, disk: readonly DiskFile[]): Promise<ChangeSet> {
    const indexed = this.files.listForRoot(root.id);
    const upserts: Upsert[] = [];
    for (const file of disk) {
      const known = indexed.get(file.path);
      indexed.delete(file.path);
      if (!known || known.missing || isModified(known, file)) {
        upserts.push({ disk: file, known });
      }
    }
    const removed = [...indexed.values()].filter((file) => !file.missing);
    return this.apply(root, upserts, removed);
  }

  /** Applies watcher results: `present` files exist on disk, `gone` paths (files or folders) do not. */
  async applyPaths(
    root: RootRecord,
    present: readonly DiskFile[],
    gone: readonly string[],
  ): Promise<ChangeSet> {
    const removed = new Map<number, IndexedFile>();
    for (const path of gone) {
      const file = this.files.findByPath(path);
      const files = file ? [file] : this.files.listUnderDir(path);
      for (const entry of files) {
        if (!entry.missing) {
          removed.set(entry.id, entry);
        }
      }
    }
    const upserts: Upsert[] = [];
    for (const disk of present) {
      const known = this.files.findByPath(disk.path);
      if (known) {
        removed.delete(known.id);
      }
      if (!known || known.missing || isModified(known, disk)) {
        upserts.push({ disk, known });
      }
    }
    return this.apply(root, upserts, [...removed.values()]);
  }

  private async apply(
    root: RootRecord,
    upserts: readonly Upsert[],
    removed: readonly IndexedFile[],
  ): Promise<ChangeSet> {
    const changed: number[] = [];
    const deleted: number[] = [];

    // Removals first, so that a file moved within this same batch is already "missing" below.
    const now = Date.now();
    const vanished: IndexedFile[] = [];
    this.files.transaction(() => {
      for (const file of removed) {
        if (this.expected.delete(file.id)) {
          deleted.push(file.id);
        } else {
          this.files.markMissing(file.id, now);
          changed.push(file.id);
          vanished.push(file);
        }
      }
      this.files.delete(deleted);
    });

    // A new path may be where a missing file went; so may a recent file whose content just changed:
    // a copy still being written when its source vanished.
    const relocations = await this.matchMissing(
      upserts.filter(({ disk, known }) => !known || isGrowingCopy(known, disk, now)),
    );

    this.files.transaction(() => {
      for (const { disk, known } of upserts) {
        const record = toRecord(root, disk);
        if (!record) {
          continue;
        }
        const relocated = relocations.get(disk.path);
        if (relocated !== undefined && known) {
          this.files.merge(relocated, known.id, record);
          changed.push(relocated);
          deleted.push(known.id);
        } else if (relocated !== undefined) {
          this.files.relocate(relocated, record);
          changed.push(relocated);
        } else if (known) {
          this.files.update(known.id, record, isContentChanged(known, disk));
          changed.push(known.id);
        } else {
          changed.push(this.files.insert(record, now));
        }
      }
    });

    // Files that vanished after a copy of them appeared: the copy becomes the file.
    const found = new Set(relocations.values());
    const merges = await this.matchRecent(
      vanished.filter((file) => !found.has(file.id)),
      now,
    );
    this.files.transaction(() => {
      for (const [missingId, recentId] of merges) {
        this.files.merge(missingId, recentId);
        deleted.push(recentId);
      }
    });

    return { changed, deleted };
  }

  /** Forgets untagged files that vanished over `MOVE_WINDOW_MS` ago and were not found again. */
  sweep(now = Date.now()): ChangeSet {
    const deleted = this.files.purgeMissingUntagged(now - MOVE_WINDOW_MS);
    return deleted.length > 0 ? { changed: [], deleted } : NO_CHANGES;
  }

  /** The app is about to delete `id`: when it vanishes, it is dropped rather than matched. */
  expectDeletion(id: number): void {
    this.expected.add(id);
  }

  /**
   * After the app tried to delete `id`: drops it if it is gone, keeps it if it is still (or again)
   * at its path.
   */
  async forget(id: number): Promise<ChangeSet> {
    this.expected.delete(id);
    const path = this.files.pathOf(id);
    if (path === null || (await statFile(path)) !== null) {
      return NO_CHANGES;
    }
    this.files.delete([id]);
    return { changed: [], deleted: [id] };
  }

  /** Finds, for new files, the missing file each one is (path → id). */
  private async matchMissing(fresh: readonly Upsert[]): Promise<Map<string, number>> {
    const matches = new Map<string, number>();
    if (fresh.length === 0 || !this.files.hasMissing()) {
      return matches;
    }
    const claimed = new Set<number>();
    for (const { disk } of fresh) {
      const candidates = this.files
        .missingCandidates(disk.size)
        .filter((candidate) => !claimed.has(candidate.id));
      if (candidates.length === 0) {
        continue;
      }
      let match = candidates.find((candidate) => isSameInode(candidate, disk));
      if (!match && candidates.some((candidate) => candidate.fingerprint !== null)) {
        const print = await fingerprint(disk.path, disk.size).catch(() => null);
        match = candidates.find((candidate) => print !== null && candidate.fingerprint === print);
      }
      if (match) {
        matches.set(disk.path, match.id);
        claimed.add(match.id);
      }
    }
    return matches;
  }

  /** Finds, for files that just vanished, a recently added file that is the same (id → id). */
  private async matchRecent(
    vanished: readonly IndexedFile[],
    now: number,
  ): Promise<Map<number, number>> {
    const matches = new Map<number, number>();
    const claimed = new Set<number>();
    for (const file of vanished) {
      const candidates = this.files
        .recentCandidates(file.size, now - MOVE_WINDOW_MS)
        .filter((candidate) => !claimed.has(candidate.id));
      let match = candidates.find((candidate) => isSameInode(candidate, file));
      if (!match && file.fingerprint !== null) {
        for (const candidate of candidates) {
          const print =
            candidate.fingerprint ??
            (await fingerprint(candidate.path, candidate.size).catch(() => null));
          if (print === file.fingerprint) {
            match = candidate;
            break;
          }
        }
      }
      if (match) {
        matches.set(file.id, match.id);
        claimed.add(match.id);
      }
    }
    return matches;
  }
}

/** Same volume, same inode, same last modification: the same file, wherever it is now. */
function isSameInode(
  a: { readonly fileId: string | null; readonly mtimeMs: number },
  b: { readonly fileId: string | null; readonly mtimeMs: number },
): boolean {
  return a.fileId !== null && a.fileId === b.fileId && a.mtimeMs === b.mtimeMs;
}

/** A file added recently whose content changed since: possibly a copy still being written. */
function isGrowingCopy(known: IndexedFile, disk: DiskFile, now: number): boolean {
  return (
    !known.missing &&
    known.addedAt !== null &&
    known.addedAt >= now - MOVE_WINDOW_MS &&
    isContentChanged(known, disk)
  );
}

function isContentChanged(known: IndexedFile, disk: DiskFile): boolean {
  return known.size !== disk.size || known.mtimeMs !== disk.mtimeMs;
}

function isModified(known: IndexedFile, disk: DiskFile): boolean {
  return isContentChanged(known, disk) || known.fileId !== disk.fileId;
}

function toRecord(root: RootRecord, disk: DiskFile): FileRecord | null {
  const { dir, name, ext } = splitPath(root.path, disk.path);
  const format = formatOf(ext);
  if (!format) {
    return null;
  }
  return {
    rootId: root.id,
    path: disk.path,
    dir,
    name,
    ext,
    kind: format.kind,
    size: disk.size,
    mtimeMs: disk.mtimeMs,
    birthtimeMs: disk.birthtimeMs,
    fileId: disk.fileId,
  };
}
