import type { FileKind } from '@shared/model';
import type { Db } from '../database/database';
import { openDatabase } from '../database/database';
import { FilesRepository } from '../library/files-repository';
import { formatOf } from '../library/formats';
import type { RootRecord } from '../library/roots-repository';
import { RootsRepository } from '../library/roots-repository';
import { TagsRepository } from '../library/tags-repository';

export interface TestLibrary {
  readonly db: Db;
  readonly files: FilesRepository;
  readonly tags: TagsRepository;
  readonly roots: RootsRepository;
  /** The library folder at `/library`. */
  readonly root: RootRecord;
  /** Inserts a file under `/library` (or `root`) and returns its id. `relativePath` uses `/`. */
  readonly addFile: (
    relativePath: string,
    options?: {
      readonly size?: number;
      readonly mtimeMs?: number;
      /** `<device>:<inode>`; none by default. */
      readonly fileId?: string;
      /** Another library folder to put the file in. */
      readonly root?: RootRecord;
      readonly fingerprint?: string;
      readonly contentHash?: string;
      /** Marks the file missing from disk since then. */
      readonly missingSince?: number;
    },
  ) => number;
}

/** An in-memory, fully migrated library database with one root at `/library`. */
export function createTestLibrary(): TestLibrary {
  const db = openDatabase(':memory:');
  const files = new FilesRepository(db);
  const tags = new TagsRepository(db);
  const roots = new RootsRepository(db);
  const root = roots.insert('/library');
  let clock = 1_000;

  const addFile: TestLibrary['addFile'] = (relativePath, options = {}) => {
    const slash = relativePath.lastIndexOf('/');
    const name = relativePath.slice(slash + 1);
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const kind: FileKind = formatOf(ext)?.kind ?? 'image';
    const parent = options.root ?? root;
    const target = {
      path: `${parent.path}/${relativePath}`,
      size: options.size ?? 1_000,
      mtimeMs: options.mtimeMs ?? clock++,
    };
    const id = files.insert({
      ...target,
      rootId: parent.id,
      dir: slash === -1 ? '' : relativePath.slice(0, slash),
      name,
      ext,
      kind,
      birthtimeMs: null,
      fileId: options.fileId ?? null,
    });
    if (options.fingerprint !== undefined) {
      files.setFingerprint({ id, ...target }, options.fingerprint);
    }
    if (options.contentHash !== undefined) {
      files.setContentHash({ id, ...target }, options.contentHash);
    }
    if (options.missingSince !== undefined) {
      files.markMissing(id, options.missingSince);
    }
    return id;
  };

  return { db, files, tags, roots, root, addFile };
}
