import type { TagStudioDetails, TagStudioLeftOut, TagStudioRename } from '@shared/model';
import { MAX_TAG_NAME_LENGTH, normalizeTagName, tagKey } from '@shared/tag-names';
import type { TagNameProblem } from '@shared/tag-names';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TagDefinition } from '../library/tags-repository';
import { Slicer } from './slices';
import type { ImportEntry, ParsedTagFile } from './tag-file';
import {
  MAX_DEFINED_NAMES,
  MAX_DISTINCT_TAGS,
  MAX_REL_LENGTH,
  MAX_SEGMENT_LENGTH,
  MAX_TAGS,
} from './tag-file';

/** The folder of a TagStudio library that holds its database, inside the library's folder. */
export const TAGSTUDIO_FOLDER = '.TagStudio';
const SQL_FILENAME = 'ts_library.sqlite';
/** TagStudio 9.4 and earlier: converted to `SQL_FILENAME` when a later TagStudio opens it. */
const JSON_FILENAME = 'ts_library.json';
/** The first version of TagStudio's SQLite database. */
const MIN_VERSION = 6;
/**
 * The last version read. From 100 on, a version is its major version times 100 plus a minor one:
 * TagStudio opens a library whose major version is not above its own, and this reads what major
 * version 4 writes (checked against its source at version 400).
 */
const MAX_VERSION = 499;
/** Below this version, the two columns of `tag_parents` were the wrong way round. */
const PARENTS_FIXED = 100;
/** Ids TagStudio keeps for its built-in tags. */
const BUILT_IN_END = 999;
/** The built-in category of Archived and Favorite: it never comes over. */
const META_TAGS = 2;
/** Largest database read: it is copied before it is read. */
export const MAX_LIBRARY_BYTES = 1024 * 1024 * 1024;
/**
 * Longest name or alias read, in UTF-16 units: longer than a name may be (1,024), so that one a
 * little too long is said to be, not cut. Past it, only its beginning is read.
 */
const MAX_NAME_UNITS = 4_096;
/** Tagged files read, at most: far more than a library holds, and bounded like a tags export. */
const MAX_TAGGED_FILES = 1_000_000;
/** Names imported as other names, or left out, listed in the preview. */
const MAX_RENAMED_ITEMS = 100;
/** Longest name shown in that list: one past `MAX_TAG_NAME_LENGTH` would fill the page. */
const MAX_SHOWN_UNITS = 200;
const MAX_PROBLEMS = 5;
/** Names of the copies of databases being read, in the folder they are copied to. */
const COPY_PREFIX = 'tagstudio-';

const NOT_A_LIBRARY =
  'This folder is not a TagStudio library: choose the folder that holds its .TagStudio folder.';
const JSON_LIBRARY =
  'This TagStudio library was saved by TagStudio 9.4 or earlier. Open it once in a recent ' +
  'TagStudio, which converts it, then import it again.';
const TOO_LARGE = 'This TagStudio library is too large to be imported.';
const CANNOT_READ = 'Cannot read this TagStudio library.';
const TOO_OLD =
  'This TagStudio library was saved by a test version of TagStudio: it cannot be read.';
const NEWER =
  'This TagStudio library was saved by a newer version of TagStudio than SG Tag can read.';
const TOO_MANY_TAGS = 'This TagStudio library has too many tags to be imported.';
const TOO_MANY_FILES = 'This TagStudio library has too many tagged files to be imported.';
const NOTHING_TO_READ = 'This TagStudio library has no tag to import.';

/** Problems of a name that `importName` rewrites rather than refuse. */
const REWRITTEN: ReadonlySet<TagNameProblem> = new Set(['comma', 'quote', 'equals', 'control']);
/** The left-to-right and right-to-left overrides, which a name may not hold. */
const OVERRIDES = new RegExp(`[${String.fromCodePoint(0x202d, 0x202e)}]`, 'gu');
/** A leading `=`, or several, and what nobody sees around them: a name is compared without it. */
const LEADING_EQUALS =
  /^[\s\p{Default_Ignorable_Code_Point}]*(?:=[\s\p{Default_Ignorable_Code_Point}]*)+/u;

/** A TagStudio library read for import. */
export interface TagStudioLibrary {
  /**
   * As a tags export would be read: its one library folder is the library's folder on this
   * computer, its tags definitions, and each tagged file an entry known by its place alone.
   */
  readonly parsed: ParsedTagFile;
  readonly details: TagStudioDetails;
}

export interface TagStudioReadOptions {
  /** Where the database is copied to be read, and deleted from once read: in the data folder. */
  readonly copiesDir: string;
  readonly signal: AbortSignal;
  /** Rows of tagged files read, out of all of them. */
  readonly onProgress: (done: number, total: number) => void;
}

/** A refusal whose message is what the user is told. */
class TagStudioError extends Error {
  override readonly name = 'TagStudioError';
}

/**
 * Reads the TagStudio library in `chosen`, the folder picked in the open dialog: the library's own
 * folder, or its `.TagStudio` folder. Throws, saying why, when it cannot be imported.
 *
 * Its database is copied into `copiesDir` and the copy read, then deleted: a running TagStudio is
 * neither locked nor disturbed. Reading runs no code of the file (`trusted_schema`, plain tables
 * and columns only), never opens a path it names, and holds the worker a slice at a time.
 */
export async function readTagStudioLibrary(
  chosen: string,
  options: TagStudioReadOptions,
): Promise<TagStudioLibrary> {
  const { signal } = options;
  const { folder, database } = await locate(chosen);
  const info = await stat(database).catch((error: unknown) => {
    throw new TagStudioError(CANNOT_READ, { cause: error });
  });
  if (info.size > MAX_LIBRARY_BYTES) {
    throw new TagStudioError(TOO_LARGE);
  }
  signal.throwIfAborted();
  const copy = await copyDatabase(database, options.copiesDir);
  try {
    signal.throwIfAborted();
    const db = new Database(copy);
    try {
      return await new LibraryReader(db, folder, info.mtime.toISOString(), options).read();
    } finally {
      db.close();
    }
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    throw error instanceof TagStudioError
      ? error
      : new TagStudioError(CANNOT_READ, { cause: error });
  } finally {
    await removeCopy(copy);
  }
}

/**
 * The folder of the library in `chosen` and its database. The `.TagStudio` folder itself may be
 * chosen: the library is the folder holding it.
 */
async function locate(chosen: string): Promise<{ folder: string; database: string }> {
  const resolved = path.resolve(chosen);
  const own = path.basename(resolved).toLowerCase() === TAGSTUDIO_FOLDER.toLowerCase();
  const folder = own ? path.dirname(resolved) : resolved;
  const data = own ? resolved : path.join(resolved, TAGSTUDIO_FOLDER);
  const database = path.join(data, SQL_FILENAME);
  if (await isFile(database)) {
    return { folder, database };
  }
  throw new TagStudioError(
    (await isFile(path.join(data, JSON_FILENAME))) ? JSON_LIBRARY : NOT_A_LIBRARY,
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Copies `database` into `dir`, with the journal or write-ahead log beside it, if any: opening the
 * copy writes what they hold into it. Copies left by a reading that never ended are removed first.
 */
async function copyDatabase(database: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (name.startsWith(COPY_PREFIX)) {
      await rm(path.join(dir, name), { force: true });
    }
  }
  const copy = path.join(dir, `${COPY_PREFIX}${randomUUID()}.sqlite`);
  try {
    await copyFile(database, copy);
    for (const suffix of ['-journal', '-wal']) {
      if (await isFile(database + suffix)) {
        await copyFile(database + suffix, copy + suffix);
      }
    }
  } catch (error) {
    await removeCopy(copy);
    throw new TagStudioError(CANNOT_READ, { cause: error });
  }
  return copy;
}

async function removeCopy(copy: string): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await rm(copy + suffix, { force: true }).catch(() => undefined);
  }
}

/** A tag of the library, as read. */
interface ReadTag {
  readonly id: number;
  /** `null` when it is not text. Past `MAX_NAME_UNITS`, its beginning only. */
  readonly name: string | null;
  readonly shorthand: string | null;
  readonly colored: boolean;
  readonly iconic: boolean;
  readonly category: boolean;
  readonly hidden: boolean;
  readonly disambiguation: number | null;
  /** Ids of its parent tags, each once, as read: some may not come over. */
  readonly parents: number[];
  /** Its aliases as read, in order. */
  readonly aliases: (string | null)[];
}

/** A tag that comes over, and the name it comes over as. */
interface ImportedTag {
  readonly tag: ReadTag;
  /** As `normalizeTagName` leaves it: the rewritten name, before same names are told apart. */
  readonly base: string;
  name: string;
}

/** A tagged file, from its rows of `tag_entries`. */
interface FileRows {
  readonly id: number;
  readonly path: string | null;
  /** In another folder than the library's first. */
  readonly other: boolean;
  /** Its tags that come over, by `tagKey`. */
  readonly names: Map<string, string>;
}

interface TableInfo {
  /** Its columns, lower-cased. */
  readonly columns: ReadonlySet<string>;
}

/** The rows of a TagStudio database as SG Tag imports them. */
class LibraryReader {
  private readonly db: Database.Database;
  private readonly folder: string;
  private readonly savedAt: string;
  private readonly options: TagStudioReadOptions;
  private readonly slicer: Slicer;
  /** Tables of the database, by lower-cased name. */
  private schema = new Map<string, { readonly type: string; readonly sql: string | null }>();
  private readonly renamed: TagStudioRename[] = [];
  private renamedCount = 0;
  private broken = 0;
  private invalid = 0;
  private readonly problems: string[] = [];

  constructor(
    db: Database.Database,
    folder: string,
    savedAt: string,
    options: TagStudioReadOptions,
  ) {
    this.db = db;
    this.folder = folder;
    this.savedAt = savedAt;
    this.options = options;
    this.slicer = new Slicer(options.signal);
  }

  async read(): Promise<TagStudioLibrary> {
    const { db } = this;
    // The copy is ours, but nothing is written to it from here on, and no function the file's
    // schema names runs.
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = OFF');
    this.schema = new Map(
      db
        .prepare<[], { type: string; name: string; sql: string | null }>(
          `SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view')`,
        )
        .all()
        .map((row) => [row.name.toLowerCase(), { type: row.type, sql: row.sql }]),
    );
    const tags = this.table('tags', ['id', 'name']);
    const tagEntries = this.table('tag_entries', ['tag_id', 'entry_id']);
    const entries = this.table('entries', ['id', 'path']);
    if (tags === null || tagEntries === null || entries === null) {
      throw new TagStudioError(CANNOT_READ);
    }
    const version = this.version();
    if (version < MIN_VERSION) {
      throw new TagStudioError(TOO_OLD);
    }
    if (version > MAX_VERSION) {
      throw new TagStudioError(NEWER);
    }
    const aliases = this.table('tag_aliases', ['tag_id', 'name']);
    const parents = this.table('tag_parents', ['parent_id', 'child_id']);
    if (this.count('tags') > MAX_DISTINCT_TAGS) {
      throw new TagStudioError(TOO_MANY_TAGS);
    }
    const links =
      (aliases ? this.count('tag_aliases') : 0) + (parents ? this.count('tag_parents') : 0);
    if (links > MAX_DEFINED_NAMES) {
      throw new TagStudioError(TOO_MANY_TAGS);
    }

    const read = await this.readTags(tags);
    if (aliases) {
      await this.readAliases(read);
    }
    if (parents) {
      await this.readParents(read, version < PARENTS_FIXED);
    }
    const imported = this.imported(read);
    const definitions = this.definitions(imported);
    const {
      entries: files,
      tags: fileTags,
      otherFolders,
    } = await this.readEntries(read, imported, entries);
    if (files.length === 0 && definitions.length === 0) {
      throw new TagStudioError(NOTHING_TO_READ);
    }
    const tagCount = new Set([...imported.values()].map(({ name }) => tagKey(name))).size;
    const counted = { colors: 0, icons: 0, categories: 0, hidden: 0 };
    for (const { tag } of imported.values()) {
      counted.colors += Number(tag.colored);
      counted.icons += Number(tag.iconic);
      counted.categories += Number(tag.category);
      counted.hidden += Number(tag.hidden);
    }
    const leftOut: TagStudioLeftOut = {
      ...counted,
      fields: this.fieldCount(),
      builtIn: [...read.values()].filter((tag) => isBuiltIn(tag.id) && !imported.has(tag.id))
        .length,
      broken: this.broken,
      otherFolders,
    };
    return {
      parsed: {
        header: {
          app: 'TagStudio',
          exportedAt: this.savedAt,
          platform: process.platform,
          roots: [this.folder],
        },
        entries: files,
        definitions,
        tagCount,
        invalid: this.invalid,
        problems: this.problems,
        tags: fileTags,
      },
      details: {
        version,
        renamed: this.renamedCount,
        renamedItems: this.renamed,
        leftOut,
      },
    };
  }

  /**
   * The table `name` with its columns, or `null` when the database has none of that name or lacks
   * one of `required`. Throws when it is not a plain table: a view, a virtual table or a generated
   * column would run code of the file as it is read.
   */
  private table(name: string, required: readonly string[]): TableInfo | null {
    const found = this.schema.get(name);
    if (found === undefined) {
      return null;
    }
    if (found.type !== 'table' || /^\s*create\s+virtual\b/i.test(found.sql ?? '')) {
      throw new TagStudioError(CANNOT_READ);
    }
    const columns = this.db
      .prepare<[], { name: string; hidden: number }>(
        `SELECT name, hidden FROM pragma_table_xinfo('${name}')`,
      )
      .all();
    if (columns.some((column) => column.hidden !== 0)) {
      throw new TagStudioError(CANNOT_READ);
    }
    const names = new Set(columns.map((column) => column.name.toLowerCase()));
    return required.every((column) => names.has(column)) ? { columns: names } : null;
  }

  private count(table: string): number {
    return (
      this.db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`).get()
        ?.count ?? 0
    );
  }

  /**
   * The version of the database: in `versions` from version 101 on, in `preferences` before (a
   * table dropped in 104). Throws when neither says.
   */
  private version(): number {
    const read = (sql: string): unknown =>
      this.db.prepare<[], { value: unknown }>(sql).get()?.value;
    let value: unknown;
    if (this.table('versions', ['key', 'value'])) {
      value = read(`SELECT value FROM versions WHERE key = 'CURRENT'`);
    } else if (this.table('preferences', ['key', 'value'])) {
      value = read(`SELECT value FROM preferences WHERE key = 'DB_VERSION'`);
    }
    const version = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
      throw new TagStudioError(CANNOT_READ);
    }
    return version;
  }

  /** Every tag, by id. Columns a version lacks read as empty. */
  private async readTags(table: TableInfo): Promise<Map<number, ReadTag>> {
    const column = (name: string, expression: string, otherwise = 'NULL'): string =>
      table.columns.has(name) ? expression : otherwise;
    const statement = this.db.prepare<
      [],
      {
        id: number;
        name: string | null;
        shorthand: string | null;
        colored: number;
        iconic: number;
        category: number;
        hidden: number;
        disambiguation: number | null;
      }
    >(`
      SELECT id,
        ${textOf('name')} AS name,
        ${column('shorthand', textOf('shorthand'))} AS shorthand,
        ${column('color_slug', `COALESCE(color_slug, '') <> ''`, '0')} AS colored,
        ${column('icon', `COALESCE(icon, '') <> ''`, '0')} AS iconic,
        ${column('is_category', `COALESCE(is_category, 0) <> 0`, '0')} AS category,
        ${column('is_hidden', `COALESCE(is_hidden, 0) <> 0`, '0')} AS hidden,
        ${column('disambiguation_id', integerOf('disambiguation_id'))} AS disambiguation
      FROM tags WHERE ${isId('id')}
      ORDER BY id`);
    const tags = new Map<number, ReadTag>();
    for (const row of statement.iterate()) {
      tags.set(row.id, {
        id: row.id,
        name: row.name,
        shorthand: row.shorthand,
        colored: row.colored === 1,
        iconic: row.iconic === 1,
        category: row.category === 1,
        hidden: row.hidden === 1,
        disambiguation: row.disambiguation,
        parents: [],
        aliases: [],
      });
      await this.pause();
    }
    return tags;
  }

  /** Gives each tag its aliases, in the order they were added; those of no tag are broken. */
  private async readAliases(tags: ReadonlyMap<number, ReadTag>): Promise<void> {
    const statement = this.db.prepare<[], { tagId: number | null; name: string | null }>(`
      SELECT ${integerOf('tag_id')} AS tagId, ${textOf('name')} AS name
      FROM tag_aliases ORDER BY rowid`);
    for (const row of statement.iterate()) {
      const tag = row.tagId === null ? undefined : tags.get(row.tagId);
      if (tag === undefined) {
        this.broken++;
      } else {
        tag.aliases.push(row.name);
      }
      await this.pause();
    }
  }

  /**
   * Gives each tag its parent tags; a link to or from no tag is broken. Below version 100,
   * `parent_id` held the tag below and `child_id` its parent (`swapped`).
   */
  private async readParents(tags: ReadonlyMap<number, ReadTag>, swapped: boolean): Promise<void> {
    const statement = this.db.prepare<[], { parentId: number | null; childId: number | null }>(`
      SELECT ${integerOf('parent_id')} AS parentId, ${integerOf('child_id')} AS childId
      FROM tag_parents`);
    for (const row of statement.iterate()) {
      const [parentId, childId] = swapped
        ? [row.childId, row.parentId]
        : [row.parentId, row.childId];
      const child = childId === null ? undefined : tags.get(childId);
      if (child === undefined || parentId === null || !tags.has(parentId)) {
        this.broken++;
      } else if (!child.parents.includes(parentId)) {
        child.parents.push(parentId);
      }
      await this.pause();
    }
  }

  /**
   * The tags that come over, by id, each with its name: every tag but the built-in ones, which
   * come over only when a file has one or a tag that comes over has one as a parent tag; never
   * Meta Tags. A tag whose name cannot be one even rewritten does not come over either.
   */
  private imported(tags: ReadonlyMap<number, ReadTag>): Map<number, ImportedTag> {
    const used = new Set(
      this.db
        .prepare<[], { id: number }>(
          `SELECT DISTINCT tag_id AS id FROM tag_entries
           WHERE ${isId('tag_id')} AND tag_id BETWEEN 0 AND ${BUILT_IN_END}`,
        )
        .all()
        .map((row) => row.id),
    );
    const comes = new Set<number>();
    for (const tag of tags.values()) {
      if (tag.id !== META_TAGS && (!isBuiltIn(tag.id) || used.has(tag.id))) {
        comes.add(tag.id);
      }
    }
    // Built-in parents of tags that come over, and theirs.
    const waiting = [...comes];
    while (waiting.length > 0) {
      const tag = tags.get(waiting.pop() as number) as ReadTag;
      for (const parentId of tag.parents) {
        if (isBuiltIn(parentId) && parentId !== META_TAGS && !comes.has(parentId)) {
          comes.add(parentId);
          waiting.push(parentId);
        }
      }
    }
    const imported = new Map<number, ImportedTag>();
    for (const tag of tags.values()) {
      if (!comes.has(tag.id)) {
        continue;
      }
      const name = this.importName(tag.name);
      if (name !== null) {
        imported.set(tag.id, { tag, base: name, name });
      }
    }
    this.tellApart(imported);
    return imported;
  }

  /**
   * Gives tags that have one name and other parent tags names of their own, listed as renamed.
   * Tags of one name and the same parent tags keep it: they are one tag here. Of tags of one name,
   * those without parent tags keep it, and each other set of parent tags makes the name
   * `Name (Parent)`: its disambiguation parent first, then each parent tag in turn, until one is
   * free; then `Name (Parent) (2)`, `(3)`… A name is free when no tag or alias that comes over has
   * it.
   */
  private tellApart(imported: ReadonlyMap<number, ImportedTag>): void {
    const byName = new Map<string, ImportedTag[]>();
    const taken = new Set<string>();
    for (const each of imported.values()) {
      const key = tagKey(each.name);
      taken.add(key);
      const same = byName.get(key);
      if (same) {
        same.push(each);
      } else {
        byName.set(key, [each]);
      }
      for (const alias of [...each.tag.aliases, each.tag.shorthand]) {
        const name = alias === null ? null : nameOf(alias);
        if (name !== null) {
          taken.add(tagKey(name));
        }
      }
    }
    for (const same of byName.values()) {
      // By the parent tags that come over, in the order of their first tag (ids ascending).
      const sets = new Map<string, ImportedTag[]>();
      for (const each of same) {
        const set = parentsOf(each.tag, imported)
          .sort((a, b) => a - b)
          .join(',');
        const group = sets.get(set);
        if (group) {
          group.push(each);
        } else {
          sets.set(set, [each]);
        }
      }
      if (sets.size < 2) {
        continue;
      }
      for (const [set, group] of sets) {
        if (set === '') {
          continue;
        }
        const name = this.distinctName(group, imported, taken);
        taken.add(tagKey(name));
        for (const each of group) {
          each.name = name;
          this.rename({ from: shown(each.tag.name ?? ''), to: name, why: 'sameName' });
        }
      }
    }
  }

  /** A name for `group`, tags of one name and the same parent tags, that `taken` lacks. */
  private distinctName(
    group: readonly ImportedTag[],
    imported: ReadonlyMap<number, ImportedTag>,
    taken: ReadonlySet<string>,
  ): string {
    const [first] = group as [ImportedTag];
    const parents = parentsOf(first.tag, imported).sort((a, b) => a - b);
    const chosen = group
      .map(({ tag }) => tag.disambiguation)
      .find((id): id is number => id !== null && parents.includes(id));
    const order =
      chosen === undefined ? parents : [chosen, ...parents.filter((id) => id !== chosen)];
    const free = (name: string): string | null => {
      const check = normalizeTagName(name);
      return check.ok && !taken.has(tagKey(check.name)) ? check.name : null;
    };
    const candidates = order.map(
      (id) => `${first.base} (${(imported.get(id) as ImportedTag).base})`,
    );
    for (const candidate of candidates) {
      const name = free(candidate);
      if (name !== null) {
        return name;
      }
    }
    // Too long, or taken: numbered, after the first that can be a name at all, cut to leave room
    // for the number. Some number is free: there are fewer names than numbers.
    const stem = candidates.find((candidate) => normalizeTagName(candidate).ok) ?? first.base;
    for (let number = 2; ; number++) {
      const suffix = ` (${String(number)})`;
      const name =
        free(`${stem}${suffix}`) ??
        free(`${cut(first.base, MAX_TAG_NAME_LENGTH - suffix.length)}${suffix}`);
      if (name !== null) {
        return name;
      }
    }
  }

  /**
   * What `applyDefinitions` is given: each tag's name first, so that a name always stands for its
   * own tag, then its aliases and the names of its parent tags. An alias that is another tag's
   * name, or an earlier tag's alias, is then left out, and the preview says so.
   */
  private definitions(imported: ReadonlyMap<number, ImportedTag>): TagDefinition[] {
    const names: TagDefinition[] = [];
    const described: TagDefinition[] = [];
    for (const { tag, name } of imported.values()) {
      names.push({ name, aliases: [], parents: [] });
      const aliases: string[] = [];
      for (const alias of [...tag.aliases, tag.shorthand]) {
        if (alias === null || alias === '') {
          continue;
        }
        const kept = this.importName(alias);
        if (kept !== null) {
          aliases.push(kept);
        }
      }
      const parents = parentsOf(tag, imported).map((id) => (imported.get(id) as ImportedTag).name);
      if (aliases.length > 0 || parents.length > 0) {
        described.push({ name, aliases, parents });
      }
    }
    return [...names, ...described];
  }

  /**
   * The tagged files of the library's first folder, each with the names of its tags that come
   * over, a slice at a time: files with none are left out. Counts the rows that point at no file
   * or no tag, and the files of other folders.
   */
  private async readEntries(
    known: ReadonlyMap<number, ReadTag>,
    imported: ReadonlyMap<number, ImportedTag>,
    table: TableInfo,
  ): Promise<{ entries: ImportEntry[]; tags: Map<string, string>; otherFolders: number }> {
    const first = this.firstFolder(table);
    this.broken +=
      this.db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM tag_entries
         WHERE NOT (${isId('entry_id')}) OR entry_id NOT IN (SELECT id FROM entries)`,
        )
        .get()?.count ?? 0;
    const total = this.count('tag_entries');
    const statement = this.db.prepare<
      [],
      { id: number; path: string | null; other: number; tagId: number | null }
    >(`
      SELECT e.id AS id,
        CASE WHEN typeof(e.path) = 'text' AND length(e.path) <= ${String(MAX_REL_LENGTH)}
          THEN e.path END AS path,
        ${first === undefined ? '0' : `e.folder_id IS NOT ${String(first)}`} AS other,
        ${integerOf('te.tag_id')} AS tagId
      FROM tag_entries te JOIN entries e ON e.id = te.entry_id
      WHERE ${isId('e.id')}
      ORDER BY e.id`);
    const entries: ImportEntry[] = [];
    const tags = new Map<string, string>();
    let otherFolders = 0;
    let done = 0;
    const finish = ({ id, path: rel, other, names }: FileRows): void => {
      if (names.size === 0) {
        return;
      }
      if (other) {
        otherFolders++;
        return;
      }
      const segments = rel === null ? null : segmentsOf(rel);
      if (segments === null) {
        this.problem(`File ${String(id)}: its path cannot be read`);
        return;
      }
      if (entries.length >= MAX_TAGGED_FILES) {
        throw new TagStudioError(TOO_MANY_FILES);
      }
      if (names.size > MAX_TAGS) {
        this.problem(`File ${String(id)}: a tag was left out`);
      }
      const kept = [...names].slice(0, MAX_TAGS);
      for (const [key, name] of kept) {
        if (!tags.has(key)) {
          tags.set(key, name);
        }
      }
      entries.push({
        root: 0,
        segments,
        path: path.join(this.folder, ...segments),
        size: 0,
        mtimeMs: null,
        fingerprint: null,
        sha256: null,
        missing: false,
        tags: kept.map(([, name]) => name),
      });
    };
    // The rows of one file, which come one after another.
    // Typed as it may be, not as it starts: assigned in the loop, it is read before then.
    let current = null as FileRows | null;
    for (const row of statement.iterate()) {
      if (current?.id !== row.id) {
        if (current !== null) {
          finish(current);
        }
        current = { id: row.id, path: row.path, other: row.other === 1, names: new Map() };
      }
      const tag = row.tagId === null ? undefined : imported.get(row.tagId);
      if (tag !== undefined) {
        const key = tagKey(tag.name);
        if (!current.names.has(key)) {
          current.names.set(key, tag.name);
        }
      } else if (row.tagId === null || !known.has(row.tagId)) {
        this.broken++;
      }
      done++;
      if (this.slicer.due) {
        this.options.onProgress(done, total);
        await this.slicer.yield();
      }
    }
    if (current !== null) {
      finish(current);
    }
    this.options.onProgress(done, total);
    return { entries, tags, otherFolders };
  }

  /**
   * The id of the library's first folder, when the database lists its folders (up to version
   * 299): `undefined` when it does not, and then every file is in the library's folder.
   */
  private firstFolder(entries: TableInfo): number | null | undefined {
    if (!entries.columns.has('folder_id') || this.table('folders', ['id']) === null) {
      return undefined;
    }
    const first = this.db
      .prepare<[], { id: number | null }>(`SELECT MIN(id) AS id FROM folders WHERE ${isId('id')}`)
      .get()?.id;
    return first ?? undefined;
  }

  /** Rows of fields of files: none come over. */
  private fieldCount(): number {
    let count = 0;
    for (const name of ['text_fields', 'datetime_fields', 'boolean_fields']) {
      if (this.schema.has(name) && this.table(name, []) !== null) {
        count += this.count(name);
      }
    }
    return count;
  }

  /**
   * `input`, a name or an alias of the library, as a name here: rewritten when it holds what a
   * name cannot (`REWRITTEN`), and listed then; `null`, and listed as left out, when no name can be
   * made of it.
   */
  private importName(input: string | null): string | null {
    if (input === null) {
      this.broken++;
      return null;
    }
    const check = normalizeTagName(input);
    if (check.ok) {
      return check.name;
    }
    const name = nameOf(input);
    this.rename({ from: shown(input), to: name, why: 'characters' });
    return name;
  }

  private rename(item: TagStudioRename): void {
    this.renamedCount++;
    if (this.renamed.length < MAX_RENAMED_ITEMS) {
      this.renamed.push(item);
    }
  }

  /** Never quotes the file: problems are shown as they are. */
  private problem(reason: string): void {
    this.invalid++;
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push(`${reason}.`);
    }
  }

  private async pause(): Promise<void> {
    if (this.slicer.due) {
      await this.slicer.yield();
    }
  }
}

/** Ids of the parent tags of `tag` that come over. */
function parentsOf(tag: ReadTag, imported: ReadonlyMap<number, ImportedTag>): number[] {
  return tag.parents.filter((id) => imported.has(id));
}

function isBuiltIn(id: number): boolean {
  return id >= 0 && id <= BUILT_IN_END;
}

/** `column` when it is an integer that JavaScript holds exactly. */
function isId(column: string): string {
  return `typeof(${column}) = 'integer' AND ${column} BETWEEN -9007199254740991 AND 9007199254740991`;
}

/** SQL for `column` as an id, `NULL` when it is not one. */
function integerOf(column: string): string {
  return `CASE WHEN ${isId(column)} THEN ${column} END`;
}

/** SQL for `column` as text, its beginning only past `MAX_NAME_UNITS`; `NULL` when not text. */
function textOf(column: string): string {
  return `CASE WHEN typeof(${column}) = 'text' THEN substr(${column}, 1, ${String(MAX_NAME_UNITS + 1)}) END`;
}

/**
 * `input` without what a name cannot hold: a comma becomes a space, a double quote a single quote,
 * a control character a space; overrides, lone surrogates and a leading `=` go.
 */
export function rewrite(input: string): string {
  return input
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cs}/gu, '')
    .replace(OVERRIDES, '')
    .replaceAll(',', ' ')
    .replaceAll('"', "'")
    .replace(LEADING_EQUALS, '');
}

/**
 * `input`, a name or an alias of the library, as a name here: rewritten when it holds what a name
 * cannot (`REWRITTEN`); `null` when no name can be made of it.
 */
function nameOf(input: string): string | null {
  const check = normalizeTagName(input);
  if (check.ok) {
    return check.name;
  }
  const again = REWRITTEN.has(check.problem) ? normalizeTagName(rewrite(input)) : check;
  return again.ok ? again.name : null;
}

/** The first `units` of `text`, without a half of a character at the end. */
function cut(text: string, units: number): string {
  const start = text.slice(0, units);
  const last = start.charCodeAt(start.length - 1);
  // A high surrogate: the first half of a character outside the Basic Multilingual Plane.
  return last >= 0xd800 && last <= 0xdbff ? start.slice(0, -1) : start;
}

/** `name` as the preview lists it: its beginning only when it is very long. */
function shown(name: string): string {
  return name.length > MAX_SHOWN_UNITS ? `${name.slice(0, MAX_SHOWN_UNITS)}…` : name;
}

/**
 * The segments of `rel`, a path relative to the library's folder as TagStudio writes it (`/`
 * between folders), NFC; `null` when it does not name a file within that folder. On Windows a
 * segment cannot hold `\` or `:`, which would lead elsewhere.
 */
export function segmentsOf(rel: string, platform: string = process.platform): string[] | null {
  const segments: string[] = [];
  for (const written of rel.split('/')) {
    if (written.length > MAX_SEGMENT_LENGTH) {
      return null;
    }
    const segment = written.normalize('NFC');
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0') ||
      (platform === 'win32' && /[\\:]/.test(segment))
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}
