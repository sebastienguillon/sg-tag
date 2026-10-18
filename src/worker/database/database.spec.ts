import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { FilesRepository } from '../library/files-repository';
import { TagsRepository } from '../library/tags-repository';
import { migrate } from './database';
import { MIGRATIONS } from './migrations';

describe('migrate', () => {
  it('upgrades a library made with the first schema, keeping its files and tags', () => {
    // A library as the first version left it: a tagged file gone missing, an untagged one present.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS[0]!);
    db.pragma('user_version = 1');
    db.prepare("INSERT INTO roots (id, path, created_at) VALUES (1, '/library', 1)").run();
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
    expect(new TagsRepository(db).forFile(1).map((tag) => tag.path)).toEqual(['keep']);
    // Rows from before `added_at` are never taken for files added recently…
    expect(files.recentCandidates(1000, 0)).toEqual([]);
    // …and a tagged file missing since before the upgrade can still be found again.
    expect(files.missingCandidates(1000)).toMatchObject([{ id: 1, fingerprint: 'print-1' }]);
  });
});
