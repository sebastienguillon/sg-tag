import Database from 'better-sqlite3';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** A tag of a TagStudio library made for a case. */
export interface FixtureTag {
  readonly id: number;
  readonly name: string | null;
  readonly shorthand?: string;
  readonly color?: string;
  readonly icon?: string;
  readonly category?: boolean;
  readonly hidden?: boolean;
  readonly disambiguation?: number;
}

/** A tagged file of a TagStudio library made for a case. */
export interface FixtureFile {
  readonly id: number;
  readonly path: string;
  readonly tags: readonly number[];
  /** Its folder, up to version 299: 1, the library's, by default. */
  readonly folder?: number;
}

export interface Fixture {
  /** 102 by default, as a library of TagStudio 9.5.2. */
  readonly version?: number;
  /** With Archived, Favorite and Meta Tags, as TagStudio makes every library, unless false. */
  readonly builtIns?: boolean;
  readonly tags?: readonly FixtureTag[];
  readonly aliases?: readonly (readonly [tagId: number, name: string])[];
  /** As TagStudio means them, whatever the version stores. */
  readonly parents?: readonly (readonly [childId: number, parentId: number])[];
  readonly files?: readonly FixtureFile[];
  /** Folders up to version 299: the library's (1) by default. */
  readonly folders?: readonly number[];
  readonly fields?: number;
  /** Run once the library is written. */
  readonly sql?: string;
}

const BUILT_IN_TAGS: readonly FixtureTag[] = [
  { id: 0, name: 'Archived', hidden: true, color: 'red' },
  { id: 1, name: 'Favorite', color: 'yellow' },
  { id: 2, name: 'Meta Tags', category: true },
];
const BUILT_IN_ALIASES: readonly (readonly [number, string])[] = [
  [0, 'Archive'],
  [1, 'Favorited'],
  [1, 'Favorites'],
  [2, 'Meta'],
  [2, 'Meta Tag'],
];
const BUILT_IN_PARENTS: readonly (readonly [number, number])[] = [
  [0, 2],
  [1, 2],
];

/**
 * Writes the database of a TagStudio library in `folder`, as TagStudio's schema has it at
 * `fixture.version`, replacing any; returns its path.
 */
export async function makeTagStudioLibrary(folder: string, fixture: Fixture = {}): Promise<string> {
  const version = fixture.version ?? 102;
  const builtIns = fixture.builtIns ?? true;
  await mkdir(path.join(folder, '.TagStudio'), { recursive: true });
  const file = path.join(folder, '.TagStudio', 'ts_library.sqlite');
  await rm(file, { force: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE tags (
      id INTEGER NOT NULL PRIMARY KEY, name VARCHAR NOT NULL, shorthand VARCHAR,
      color_namespace VARCHAR, color_slug VARCHAR, is_category BOOLEAN NOT NULL,
      icon VARCHAR, disambiguation_id INTEGER
      ${version >= 103 ? ', is_hidden BOOLEAN NOT NULL DEFAULT 0' : ''}
    );
    CREATE TABLE tag_aliases (id INTEGER NOT NULL PRIMARY KEY, name VARCHAR NOT NULL, tag_id INTEGER NOT NULL);
    CREATE TABLE tag_parents (parent_id INTEGER NOT NULL, child_id INTEGER NOT NULL, PRIMARY KEY (parent_id, child_id));
    CREATE TABLE entries (
      id INTEGER NOT NULL PRIMARY KEY, ${version < 300 ? 'folder_id INTEGER NOT NULL,' : ''}
      path VARCHAR NOT NULL UNIQUE, suffix VARCHAR NOT NULL DEFAULT '', filename TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE tag_entries (tag_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, PRIMARY KEY (tag_id, entry_id));
    CREATE TABLE text_fields (value TEXT, id INTEGER NOT NULL PRIMARY KEY, type_key VARCHAR, entry_id INTEGER NOT NULL, position INTEGER);
  `);
  if (version < 300) {
    db.exec(
      'CREATE TABLE folders (id INTEGER NOT NULL PRIMARY KEY, path VARCHAR NOT NULL, uuid VARCHAR NOT NULL)',
    );
    for (const id of fixture.folders ?? [1]) {
      db.prepare('INSERT INTO folders VALUES (?, ?, ?)').run(
        id,
        `C:/Somewhere/${String(id)}`,
        `uuid-${String(id)}`,
      );
    }
  }
  if (version >= 101) {
    db.exec('CREATE TABLE versions ("key" VARCHAR NOT NULL PRIMARY KEY, value INTEGER NOT NULL)');
    db.prepare(`INSERT INTO versions VALUES ('INITIAL', ?), ('CURRENT', ?)`).run(version, version);
  }
  if (version < 104) {
    db.exec('CREATE TABLE preferences ("key" VARCHAR NOT NULL PRIMARY KEY, value JSON NOT NULL)');
    db.prepare(`INSERT INTO preferences VALUES ('DB_VERSION', ?)`).run(version);
  }
  const tags = [...(builtIns ? BUILT_IN_TAGS : []), ...(fixture.tags ?? [])];
  const insertTag = db.prepare(`
    INSERT INTO tags (id, name, shorthand, color_namespace, color_slug, is_category, icon, disambiguation_id
      ${version >= 103 ? ', is_hidden' : ''})
    VALUES (@id, @name, @shorthand, @namespace, @color, @category, @icon, @disambiguation
      ${version >= 103 ? ', @hidden' : ''})`);
  // A tag whose name is not text is stored with the column's constraint out of the way.
  db.pragma('ignore_check_constraints = ON');
  for (const tag of tags) {
    insertTag.run({
      id: tag.id,
      name: tag.name ?? 42,
      shorthand: tag.shorthand ?? null,
      namespace: tag.color === undefined ? null : 'tagstudio-standard',
      color: tag.color ?? null,
      category: tag.category === true ? 1 : 0,
      icon: tag.icon ?? null,
      disambiguation: tag.disambiguation ?? null,
      ...(version >= 103 ? { hidden: tag.hidden === true ? 1 : 0 } : {}),
    });
  }
  for (const [tagId, name] of [...(builtIns ? BUILT_IN_ALIASES : []), ...(fixture.aliases ?? [])]) {
    db.prepare('INSERT INTO tag_aliases (name, tag_id) VALUES (?, ?)').run(name, tagId);
  }
  for (const [childId, parentId] of [
    ...(builtIns ? BUILT_IN_PARENTS : []),
    ...(fixture.parents ?? []),
  ]) {
    // Below version 100, TagStudio stored each link the other way round.
    const [first, second] = version < 100 ? [childId, parentId] : [parentId, childId];
    db.prepare('INSERT INTO tag_parents (parent_id, child_id) VALUES (?, ?)').run(first, second);
  }
  for (const tagged of fixture.files ?? []) {
    const name = tagged.path.slice(tagged.path.lastIndexOf('/') + 1);
    if (version < 300) {
      db.prepare('INSERT INTO entries (id, folder_id, path, filename) VALUES (?, ?, ?, ?)').run(
        tagged.id,
        tagged.folder ?? 1,
        tagged.path,
        name,
      );
    } else {
      db.prepare('INSERT INTO entries (id, path, filename) VALUES (?, ?, ?)').run(
        tagged.id,
        tagged.path,
        name,
      );
    }
    for (const tagId of tagged.tags) {
      db.prepare('INSERT INTO tag_entries VALUES (?, ?)').run(tagId, tagged.id);
    }
  }
  for (let field = 0; field < (fixture.fields ?? 0); field++) {
    db.prepare(
      `INSERT INTO text_fields (value, type_key, entry_id, position) VALUES ('x', 'NOTES', 1, 0)`,
    ).run();
  }
  if (fixture.sql !== undefined) {
    db.exec(fixture.sql);
  }
  db.close();
  return file;
}
