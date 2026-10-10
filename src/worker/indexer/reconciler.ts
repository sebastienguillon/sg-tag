import type { FileRecord, FilesRepository, IndexedFile } from '../library/files-repository';
import { formatOf } from '../library/formats';
import { splitPath } from '../library/paths';
import type { RootRecord } from '../library/roots-repository';
import type { DiskFile } from './crawler';
import { fingerprint } from './fingerprint';

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

/**
 * Applies what is on disk to the index, preserving file identity:
 *
 * - An untagged file that disappears is deleted from the index.
 * - A tagged file that disappears is kept as "missing", so a rename or move done outside the app
 *   can be matched back to it: same device+inode with the same size and mtime (same volume), or
 *   same content fingerprint (another volume). It then keeps its id, tags and thumbnail.
 */
export class Reconciler {
  private readonly files: FilesRepository;

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
    this.files.transaction(() => {
      for (const file of removed) {
        if (file.tagged) {
          this.files.markMissing(file.id, now);
          changed.push(file.id);
        } else {
          deleted.push(file.id);
        }
      }
      this.files.delete(deleted);
    });

    const relocations = await this.matchMissing(upserts.filter(({ known }) => !known));

    this.files.transaction(() => {
      for (const { disk, known } of upserts) {
        const record = toRecord(root, disk);
        if (!record) {
          continue;
        }
        const relocated = relocations.get(disk.path);
        if (relocated !== undefined) {
          this.files.relocate(relocated, record);
          changed.push(relocated);
        } else if (known) {
          this.files.update(known.id, record, isContentChanged(known, disk));
          changed.push(known.id);
        } else {
          changed.push(this.files.insert(record));
        }
      }
    });

    return { changed, deleted };
  }

  /** Finds, for new files, the missing tagged file each one is (path → id). */
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
      let match = candidates.find(
        (candidate) => candidate.fileId === disk.fileId && candidate.mtimeMs === disk.mtimeMs,
      );
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
