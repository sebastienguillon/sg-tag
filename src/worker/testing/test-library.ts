import type { FileKind } from '@shared/model';
import type { Db } from '../database/database';
import { openDatabase } from '../database/database';
import { FilesRepository } from '../library/files-repository';
import { formatOf } from '../library/formats';
import { RootsRepository } from '../library/roots-repository';
import { TagsRepository } from '../library/tags-repository';

export interface TestLibrary {
  readonly db: Db;
  readonly files: FilesRepository;
  readonly tags: TagsRepository;
  readonly roots: RootsRepository;
  /** Inserts a file under `/library` and returns its id. `relativePath` uses `/`. */
  readonly addFile: (
    relativePath: string,
    options?: {
      readonly size?: number;
      readonly mtimeMs?: number;
      /** `<device>:<inode>`; none by default. */
      readonly fileId?: string;
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
    return files.insert({
      rootId: root.id,
      path: `/library/${relativePath}`,
      dir: slash === -1 ? '' : relativePath.slice(0, slash),
      name,
      ext,
      kind,
      size: options.size ?? 1_000,
      mtimeMs: options.mtimeMs ?? clock++,
      birthtimeMs: null,
      fileId: options.fileId ?? null,
    });
  };

  return { db, files, tags, roots, addFile };
}
