import type { FileRecord, FilesRepository, IndexedFile } from '../library/files-repository';
import { formatOf } from '../library/formats';
import { splitPath } from '../library/paths';
import type { RootRecord } from '../library/roots-repository';
import type { DiskFile } from './crawler';
import { inodeOf, statFile } from './crawler';
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

/** An indexed file found to be one on disk. */
interface Match {
  readonly id: number;
  /** Matched by device+inode: certainly the same file. Otherwise by fingerprint only. */
  readonly sure: boolean;
}

const NO_CHANGES: ChangeSet = { changed: [], deleted: [] };

/**
 * Applies what is on disk to the index, preserving file identity across renames and moves done
 * outside the app. A file is the same as another when both have the same size and either the same
 * device+inode and mtime (same volume) or the same content fingerprint (another volume; never for
 * empty files). It then keeps its id, tags and thumbnail. A same inode wins over a same fingerprint;
 * among identical files, one that vanished at the same time is taken first, then the one whose name
 * and folders are most alike.
 *
 * - A file that disappears is kept as "missing": tagged files until they reappear, untagged ones for
 *   `MOVE_WINDOW_MS` (see `sweep`). A file found at a new path, or at the path of a missing file, is
 *   matched against them.
 * - A file that disappears is also matched against files added in the last `MOVE_WINDOW_MS`, for
 *   moves whose new path was seen first. A file matched by fingerprint only, or found at the path
 *   of a missing one, counts as added too: the file it really is may vanish later.
 */
export class Reconciler {
  private readonly files: FilesRepository;
  private readonly now: () => number;
  /** Files the app is deleting itself: when they vanish, they are gone, not moved. */
  private readonly expected = new Set<number>();

  constructor(files: FilesRepository, now: () => number = Date.now) {
    this.files = files;
    this.now = now;
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
    const seen = new Set<string>();
    for (const disk of present) {
      // A folder created with its files is reported both ways.
      if (seen.has(disk.path)) {
        continue;
      }
      seen.add(disk.path);
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
    const now = this.now();
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

    const writes = upserts.flatMap((upsert) => {
      const record = toRecord(root, upsert.disk);
      return record ? [{ ...upsert, record }] : [];
    });
    // A new path may be where a missing file went; so may the path of a missing file (another file
    // renamed onto it), or a recent file whose content just changed: a copy still being written when
    // its source vanished.
    const fresh = writes.filter(
      ({ disk, known }) => !known || known.missing || isGrowingCopy(known, disk, now),
    );
    // Rows matched in this batch. Same inodes first, both ways and across the whole batch: a copy
    // recognised by its fingerprint must not take the row of a file found as itself.
    const claimed = new Set<number>();
    const matches = this.missingByInode(fresh, claimed);
    const busy = new Set(writes.flatMap(({ known }) => (known ? [known.id] : [])));
    const moved = this.recentByInode(vanished, busy, claimed, now);
    for (const [path, match] of await this.missingByFingerprint(fresh, claimed, now)) {
      matches.set(path, match);
    }

    this.files.transaction(() => {
      // A missing file found elsewhere is not the one at its path any more.
      const taken = (known: IndexedFile | undefined, path: string): boolean =>
        known !== undefined && claimed.has(known.id) && matches.get(path)?.id !== known.id;
      // It leaves that path first, for the file there to take it (even its own, in a swap).
      for (const { disk, known } of writes) {
        if (known && taken(known, disk.path)) {
          this.files.park(known.id);
        }
      }
      for (const { disk, known: atPath, record } of writes) {
        const known = taken(atPath, disk.path) ? undefined : atPath;
        const match = matches.get(disk.path);
        // Matched by fingerprint only: the file it really is may still vanish (recentByFingerprint).
        const addedAt = match?.sure === false ? now : null;
        if (match && known && match.id !== known.id) {
          this.files.merge(match.id, known.id, record, addedAt);
          changed.push(match.id);
          deleted.push(known.id);
        } else if (match && !known) {
          this.files.relocate(match.id, record, addedAt);
          changed.push(match.id);
        } else if (known) {
          // At the path of a missing file, unless it is certainly that file: it may have come from
          // elsewhere.
          const arrived = known.missing && match?.sure !== true;
          this.files.update(known.id, record, isContentChanged(known, disk), arrived ? now : null);
          changed.push(known.id);
        } else {
          changed.push(this.files.insert(record, now));
        }
      }
    });

    // Files that vanished after a copy of them appeared: the copy becomes the file.
    const copied = await this.recentByFingerprint(
      vanished.filter((file) => !claimed.has(file.id)),
      claimed,
      now,
    );
    this.files.transaction(() => {
      for (const [missingId, file] of moved) {
        this.files.merge(missingId, file.id);
        deleted.push(file.id);
      }
      for (const [missingId, file] of copied) {
        // Still open to the file it really is, but not for longer.
        this.files.merge(missingId, file.id, undefined, file.addedAt);
        deleted.push(file.id);
      }
    });

    return { changed, deleted };
  }

  /** Forgets untagged files that vanished over `MOVE_WINDOW_MS` ago and were not found again. */
  sweep(now = this.now()): ChangeSet {
    const deleted = this.files.purgeMissingUntagged(now - MOVE_WINDOW_MS);
    return deleted.length > 0 ? { changed: [], deleted } : NO_CHANGES;
  }

  /** The app is about to delete `id`: when it vanishes, it is dropped rather than matched. */
  expectDeletion(id: number): void {
    this.expected.add(id);
  }

  /** The app could not delete `id` after all: if it vanishes, it may have moved, as any file. */
  cancelDeletion(id: number): void {
    this.expected.delete(id);
  }

  /**
   * After the app tried to delete `id`: drops it if it is gone, keeps it if it is still (or again)
   * at its path. Another file at that path is not it.
   */
  async forget(id: number): Promise<ChangeSet> {
    this.expected.delete(id);
    const path = this.files.pathOf(id);
    const file = path === null ? undefined : this.files.findByPath(path);
    if (!file) {
      return NO_CHANGES;
    }
    const disk = await statFile(file.path);
    if (disk && (file.fileId === null || inodeOf(disk.fileId) === inodeOf(file.fileId))) {
      return NO_CHANGES;
    }
    this.files.delete([id]);
    return { changed: [], deleted: [id] };
  }

  /**
   * Finds, for files at new paths or at the path of a missing file, the missing file each one
   * certainly is, by inode (path → match). A missing file back at its own path matches itself.
   */
  private missingByInode(fresh: readonly Upsert[], claimed: Set<number>): Map<string, Match> {
    const matches = new Map<string, Match>();
    if (fresh.length === 0 || !this.files.hasMissing()) {
      return matches;
    }
    const claim = (path: string, id: number): void => {
      matches.set(path, { id, sure: true });
      claimed.add(id);
    };
    for (const { disk, known } of fresh) {
      if (known?.missing === true && isSameInode(known, disk)) {
        claim(disk.path, known.id);
      }
    }
    for (const { disk } of fresh) {
      const same = matches.has(disk.path)
        ? undefined
        : this.files
            .missingCandidates(disk.size)
            .find((candidate) => !claimed.has(candidate.id) && isSameInode(candidate, disk));
      if (same) {
        claim(disk.path, same.id);
      }
    }
    return matches;
  }

  /**
   * Finds, for the files left, the missing file each one is by fingerprint (path → match). A
   * missing file whose path has a file again can only be that one: no other copy takes its row.
   */
  private async missingByFingerprint(
    fresh: readonly Upsert[],
    claimed: Set<number>,
    now: number,
  ): Promise<Map<string, Match>> {
    const matches = new Map<string, Match>();
    if (fresh.length === 0 || !this.files.hasMissing()) {
      return matches;
    }
    const occupied = new Set(
      fresh.flatMap(({ known }) => (known?.missing === true ? [known.id] : [])),
    );
    for (const { disk, known } of fresh) {
      const back = known?.missing === true && !claimed.has(known.id) ? [known] : [];
      const candidates = this.files
        .missingCandidates(disk.size)
        .filter((candidate) => !occupied.has(candidate.id) && !claimed.has(candidate.id));
      if (
        matches.has(disk.path) ||
        disk.size === 0 ||
        ![...back, ...candidates].some((file) => file.fingerprint !== null)
      ) {
        continue;
      }
      const print = await fingerprint(disk.path, disk.size).catch(() => null);
      // Files that vanished in this very batch first (a move), then the most alike.
      const vanished = candidates.filter((candidate) => candidate.missingSince === now);
      const earlier = candidates.filter((candidate) => candidate.missingSince !== now);
      const copied = [
        ...back,
        ...byLikeness(vanished, disk.path),
        ...byLikeness(earlier, disk.path),
      ].find((candidate) => print !== null && candidate.fingerprint === print);
      if (copied) {
        matches.set(disk.path, { id: copied.id, sure: false });
        claimed.add(copied.id);
      }
    }
    return matches;
  }

  /**
   * Finds, for files that just vanished, a recently added file with the same inode (id → it): a
   * move whose new path was seen first. `busy` rows are written in this batch.
   */
  private recentByInode(
    vanished: readonly IndexedFile[],
    busy: ReadonlySet<number>,
    claimed: Set<number>,
    now: number,
  ): Map<number, IndexedFile> {
    const matches = new Map<number, IndexedFile>();
    for (const file of vanished) {
      const moved = claimed.has(file.id)
        ? undefined
        : this.files
            .recentCandidates(file.size, now - MOVE_WINDOW_MS)
            .find(
              (candidate) =>
                !claimed.has(candidate.id) &&
                !busy.has(candidate.id) &&
                isSameInode(candidate, file),
            );
      if (moved) {
        matches.set(file.id, moved);
        claimed.add(file.id);
        claimed.add(moved.id);
      }
    }
    return matches;
  }

  /** Finds, for files that just vanished, a recently added copy of them (id → it). */
  private async recentByFingerprint(
    vanished: readonly IndexedFile[],
    claimed: Set<number>,
    now: number,
  ): Promise<Map<number, IndexedFile>> {
    const matches = new Map<number, IndexedFile>();
    // Fingerprints read in this batch: many files may share a size (camera raws), each is read once.
    const read = new Map<number, string | null>();
    for (const file of vanished) {
      if (file.fingerprint === null || file.size === 0) {
        continue;
      }
      const candidates = this.files
        .recentCandidates(file.size, now - MOVE_WINDOW_MS)
        .filter((candidate) => !claimed.has(candidate.id));
      for (const candidate of byLikeness(candidates, file.path)) {
        if ((await this.fingerprintOf(candidate, read)) === file.fingerprint) {
          matches.set(file.id, candidate);
          claimed.add(candidate.id);
          break;
        }
      }
    }
    return matches;
  }

  /** The fingerprint of a present file, read and stored if it has none yet. */
  private async fingerprintOf(
    file: IndexedFile,
    read: Map<number, string | null>,
  ): Promise<string | null> {
    if (file.fingerprint !== null) {
      return file.fingerprint;
    }
    if (!read.has(file.id)) {
      const print = await fingerprint(file.path, file.size).catch(() => null);
      if (print !== null) {
        this.files.setFingerprint(file, print);
      }
      read.set(file.id, print);
    }
    return read.get(file.id) ?? null;
  }
}

/** Same volume, same inode, same last modification: the same file, wherever it is now. */
function isSameInode(
  a: { readonly fileId: string | null; readonly mtimeMs: number },
  b: { readonly fileId: string | null; readonly mtimeMs: number },
): boolean {
  return a.fileId !== null && a.fileId === b.fileId && a.mtimeMs === b.mtimeMs;
}

/**
 * `candidates` in the order to try them as `target`: the same name first, then also the same parent
 * folder name, and so on (a folder of identical files moved elsewhere keeps its layout).
 */
function byLikeness<T extends { readonly path: string }>(
  candidates: readonly T[],
  target: string,
): T[] {
  const segments = target.split(/[\\/]/).reverse();
  const likeness = (candidate: T): number => {
    const other = candidate.path.split(/[\\/]/).reverse();
    let same = 0;
    while (same < segments.length && segments[same] === other[same]) {
      same++;
    }
    return same;
  };
  return candidates
    .map((candidate) => ({ candidate, likeness: likeness(candidate) }))
    .sort((a, b) => b.likeness - a.likeness)
    .map(({ candidate }) => candidate);
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
