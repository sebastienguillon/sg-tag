import type { FileKind, Tag, TagEditResult } from '@shared/model';
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
  /** `defineTag` in this library: a tag with aliases and parents. Tag files with `tags`. */
  readonly addTag: (name: string, definition?: TagDefinition) => number;
}

/** What a tag is given besides its name. */
export interface TagDefinition {
  readonly aliases?: readonly string[];
  /** The names of its parents, each made a tag when no tag has it. */
  readonly parents?: readonly string[];
}

/**
 * The tag as a change left it. Throws when the repository refused the change, so that no spec goes
 * on with less than it asked for.
 */
export function editedTag(result: TagEditResult): Tag {
  if (!result.ok) {
    throw new Error(`The change to the tag was refused: ${JSON.stringify(result.error)}`);
  }
  return result.tag;
}

/**
 * Makes the tag named `name`, unless a tag has that name or alias already, gives it the aliases of
 * `definition` and puts it below its parents; returns the id of the tag. Throws when the repository
 * refuses any of it.
 */
export function defineTag(
  tags: TagsRepository,
  name: string,
  { aliases = [], parents = [] }: TagDefinition = {},
): number {
  const id = tags.resolve([name])[0]?.id ?? editedTag(tags.createTag(name)).id;
  for (const alias of aliases) {
    editedTag(tags.addAlias(id, alias));
  }
  for (const parent of parents) {
    editedTag(tags.addParent(id, parent));
  }
  return id;
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

  const addTag: TestLibrary['addTag'] = (name, definition) => defineTag(tags, name, definition);

  return { db, files, tags, roots, root, addFile, addTag };
}
