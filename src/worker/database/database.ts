import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

/** Opens (or creates) the library database and brings its schema up to date. */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // 64 MiB
  db.pragma('mmap_size = 268435456'); // 256 MiB
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  MIGRATIONS.slice(current).forEach((sql, offset) => {
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${current + offset + 1}`);
    })();
  });
}

/** Binds a list of integers as one JSON parameter, for `IN (SELECT value FROM json_each(?))`. */
export function jsonIds(ids: Iterable<number>): string {
  return JSON.stringify(Array.from(ids));
}
