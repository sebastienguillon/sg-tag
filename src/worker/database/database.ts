import { NEWER_LIBRARY_MESSAGE } from '@shared/worker-api';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

/**
 * Opens (or creates) the library database and brings its schema up to date. Throws
 * `NewerLibraryError` for a library this build cannot read.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // 64 MiB
  db.pragma('mmap_size = 268435456'); // 256 MiB
  try {
    migrate(db);
  } catch (error) {
    // Nobody else can close it: the caller never gets the database it could not open.
    db.close();
    throw error;
  }
  return db;
}

/**
 * The library was last opened by a build that knows more migrations than this one: its schema
 * cannot be read here. Its message is the sentence the main process shows the user.
 */
export class NewerLibraryError extends Error {
  override readonly name = 'NewerLibraryError';

  constructor() {
    super(NEWER_LIBRARY_MESSAGE);
  }
}

/**
 * Applies the migrations the database has not had yet, each in its own transaction. Throws
 * `NewerLibraryError`, changing nothing, when it has had more than this build knows.
 */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new NewerLibraryError();
  }
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
