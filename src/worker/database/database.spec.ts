import Database from 'better-sqlite3';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesRepository } from '../library/files-repository';
import { SettingsRepository } from '../library/settings-repository';
import { TagsRepository } from '../library/tags-repository';
import type { Db } from './database';
import { migrate, NewerLibraryError, openDatabase } from './database';
import { MIGRATIONS } from './migrations';

/** A library as the build that knew `version` migrations left it, with its folder `/library`. */
function libraryAt(version: number): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS.slice(0, version)) {
    db.exec(sql);
  }
  db.pragma(`user_version = ${version}`);
  db.prepare("INSERT INTO roots (id, path, created_at) VALUES (1, '/library', 1)").run();
  return db;
}

describe('migrate', () => {
  it('upgrades a library made with the first schema, keeping its files', () => {
    // A library as the first version left it: a tagged file gone missing, an untagged one present.
    const db = libraryAt(1);
    const insert = db.prepare<[number, string, string | null, number | null]>(`
      INSERT INTO files
        (id, root_id, path, dir, name, ext, kind, size, mtime_ms, fingerprint, missing_since)
      VALUES (?, 1, ?, '', 'a.jpg', 'jpg', 'image', 1000, 1, ?, ?)`);
    insert.run(1, '/library/tagged/a.jpg', 'print-1', 5);
    insert.run(2, '/library/untagged/a.jpg', 'print-2', null);
    db.prepare("INSERT INTO tags (id, name, path, created_at) VALUES (1, 'keep', 'keep', 1)").run();
    db.prepare('INSERT INTO file_tags (file_id, tag_id) VALUES (1, 1)').run();

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare(
          'SELECT id, fingerprint, missing_since, added_at, content_hash FROM files ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 1, fingerprint: 'print-1', missing_since: 5, added_at: null, content_hash: null },
      { id: 2, fingerprint: 'print-2', missing_since: null, added_at: null, content_hash: null },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").pluck().all()).toEqual(
      expect.arrayContaining(['files_content_hash', 'files_unprinted']),
    );

    const files = new FilesRepository(db);
    // Its tags were paths: they are not carried over.
    expect(new TagsRepository(db).forFile(1)).toEqual([]);
    // Rows from before `added_at` are never taken for files added recently…
    expect(files.recentCandidates(1000, 0)).toEqual([]);
    // …and a file missing since before the upgrade can still be found again.
    expect(files.missingCandidates(1000)).toMatchObject([{ id: 1, fingerprint: 'print-1' }]);
  });

  it('drops the tags of a library that had them as paths, and nothing else', () => {
    const db = libraryAt(2);
    const insertFile = db.prepare<[number, string, string, string | null, number | null]>(`
      INSERT INTO files
        (id, root_id, path, dir, name, ext, kind, size, mtime_ms, fingerprint, content_hash,
         missing_since)
      VALUES (?, 1, ?, '', ?, 'jpg', 'image', 1000, 1, 'print', ?, ?)`);
    insertFile.run(1, '/library/Été à la plage.jpg', 'Été à la plage.jpg', 'hash-1', null);
    insertFile.run(2, '/library/gone.jpg', 'gone.jpg', null, 5);
    // A chain of tags deeper than the 1,000 levels SQLite follows a cascade through. Their paths
    // only have to differ: written in full, they would take megabytes.
    const depth = 1_500;
    const insertTag = db.prepare<[number, number | null, string]>(
      "INSERT INTO tags (id, parent_id, name, path, created_at) VALUES (?, ?, 'level', ?, 1)",
    );
    db.transaction(() => {
      for (let level = 1; level <= depth; level++) {
        insertTag.run(level, level === 1 ? null : level - 1, `level ${level}`);
      }
    })();
    db.exec(`INSERT INTO file_tags (file_id, tag_id) VALUES (1, ${depth}), (2, 1), (2, ${depth})`);

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db.prepare('SELECT id, name, fingerprint, content_hash, missing_since FROM files').all(),
    ).toEqual([
      {
        id: 1,
        name: 'Été à la plage.jpg',
        fingerprint: 'print',
        content_hash: 'hash-1',
        missing_since: null,
      },
      { id: 2, name: 'gone.jpg', fingerprint: 'print', content_hash: null, missing_since: 5 },
    ]);
    // The index of names is whole, and still follows the files.
    const named = db.prepare<[string]>('SELECT rowid FROM files_fts WHERE files_fts MATCH ?');
    expect(named.pluck().all('"ete a la"')).toEqual([1]);
    db.prepare("UPDATE files SET name = 'Hiver.jpg' WHERE id = 1").run();
    expect(named.pluck().all('"ete a la"')).toEqual([]);
    expect(named.pluck().all('"hiver"')).toEqual([1]);

    const count = (table: string): unknown =>
      db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
    expect(['tags', 'tag_names', 'tag_parents', 'file_tags'].map(count)).toEqual([0, 0, 0, 0]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").pluck().all()).toEqual(
      expect.arrayContaining([
        'tag_names_primary',
        'tag_names_tag',
        'tag_names_fold',
        'tag_parents_parent',
        'file_tags_tag',
      ]),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');

    // Files can be tagged again, the missing one included.
    const tags = new TagsRepository(db);
    expect(tags.addToFiles([1, 2], ['Été'])).toMatchObject([{ status: 'added' }]);
    expect(tags.list()).toMatchObject([{ name: 'Été', fileCount: 2 }]);

    // What the repository never tries, the schema refuses: a second name for a tag, and a tag as
    // its own parent.
    const id = tags.list()[0]?.id;
    expect(() =>
      db
        .prepare(
          `INSERT INTO tag_names (key, fold, name, tag_id, is_alias)
           VALUES ('second', 'second', 'second', ?, 0)`,
        )
        .run(id),
    ).toThrow('UNIQUE constraint failed: tag_names.tag_id');
    expect(() =>
      db.prepare('INSERT INTO tag_parents (tag_id, parent_id) VALUES (?, ?)').run(id, id),
    ).toThrow('CHECK constraint failed');
  });

  it('leaves a library as it was when a migration fails halfway', () => {
    const db = libraryAt(2);
    db.exec(`
      INSERT INTO files (id, root_id, path, dir, name, ext, kind, size, mtime_ms)
      VALUES (1, 1, '/library/a.jpg', '', 'a.jpg', 'jpg', 'image', 1000, 1);
      INSERT INTO tags (id, name, path, created_at) VALUES (1, 'keep', 'keep', 1);
      INSERT INTO file_tags (file_id, tag_id) VALUES (1, 1);`);
    // The migration that drops the tags then fails to make a table: one of that name is there.
    db.exec('CREATE TABLE tag_parents (unexpected INTEGER)');

    expect(() => {
      migrate(db);
    }).toThrow('table tag_parents already exists');

    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare('SELECT id, path FROM tags').all()).toEqual([{ id: 1, path: 'keep' }]);
    expect(db.prepare('SELECT file_id, tag_id FROM file_tags').all()).toEqual([
      { file_id: 1, tag_id: 1 },
    ]);
  });

  it('forgets the latest tags export, which can no longer be imported, and keeps the settings', () => {
    const db = libraryAt(2);
    const settings = new SettingsRepository(db);
    settings.update({ tileSize: 200 });
    settings.recordTagExport({ at: 1_760_000_000_000, path: '/Users/seb/tags.jsonl', files: 12 });

    migrate(db);

    expect(settings.lastTagExport()).toBeNull();
    expect(settings.get().tileSize).toBe(200);
  });

  it('refuses a library made by a newer version, in words for the user, and leaves it as it is', () => {
    const db = libraryAt(MIGRATIONS.length);
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    const schema = db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name');
    const before = schema.all();

    expect(() => {
      migrate(db);
    }).toThrow(NewerLibraryError);
    expect(() => {
      migrate(db);
    }).toThrow('This library was made by a newer version of SG Tag. Update SG Tag to open it.');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length + 1);
    expect(schema.all()).toEqual(before);
  });
});

describe('openDatabase', () => {
  it('closes a library it cannot open', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-database-'));
    try {
      const file = path.join(dir, 'library.db');
      const db = openDatabase(file);
      db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
      db.close();

      expect(() => openDatabase(file)).toThrow(NewerLibraryError);
      // Closing the last connection removes the write-ahead log beside the database.
      expect(await readdir(dir)).toEqual(['library.db']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
