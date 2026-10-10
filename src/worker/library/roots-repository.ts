import type { Db } from '../database/database';

export interface RootRecord {
  readonly id: number;
  readonly path: string;
}

export interface RootStats {
  readonly fileCount: number;
  readonly taggedCount: number;
}

function prepareStatements(db: Db) {
  return {
    list: db.prepare<[], RootRecord>('SELECT id, path FROM roots ORDER BY path'),
    get: db.prepare<[number], RootRecord>('SELECT id, path FROM roots WHERE id = ?'),
    insert: db.prepare<[string, number]>('INSERT INTO roots (path, created_at) VALUES (?, ?)'),
    delete: db.prepare<[number]>('DELETE FROM roots WHERE id = ?'),
    stats: db.prepare<[number, number], RootStats>(`
      SELECT
        (SELECT COUNT(*) FROM files WHERE root_id = ? AND missing_since IS NULL) AS fileCount,
        (SELECT COUNT(DISTINCT ft.file_id) FROM file_tags ft JOIN files f ON f.id = ft.file_id
         WHERE f.root_id = ?) AS taggedCount`),
  };
}

export class RootsRepository {
  private readonly statements: ReturnType<typeof prepareStatements>;

  constructor(db: Db) {
    this.statements = prepareStatements(db);
  }

  list(): RootRecord[] {
    return this.statements.list.all();
  }

  get(id: number): RootRecord | undefined {
    return this.statements.get.get(id);
  }

  insert(path: string): RootRecord {
    const id = Number(this.statements.insert.run(path, Date.now()).lastInsertRowid);
    return { id, path };
  }

  /** Deleting a root cascades to its files and their tag assignments. */
  delete(id: number): void {
    this.statements.delete.run(id);
  }

  stats(id: number): RootStats {
    return this.statements.stats.get(id, id) ?? { fileCount: 0, taggedCount: 0 };
  }
}
