import type { Tag, TagRef, TagUsage } from '@shared/model';
import type { Db } from '../database/database';
import { jsonIds } from '../database/database';

/**
 * Normalises a user-typed tag path: segments are trimmed and whitespace-collapsed, empty segments
 * dropped. Returns `null` when nothing is left. `' Trips / 2024//Japan '` → `'Trips/2024/Japan'`.
 */
export function normalizeTagPath(input: string): string | null {
  const segments = input
    .normalize('NFC')
    .split('/')
    .map((segment) => segment.trim().replace(/\s+/g, ' '))
    .filter((segment) => segment !== '');
  return segments.length > 0 ? segments.join('/') : null;
}

/** A tag path as the database compares it (`COLLATE NOCASE`): only ASCII letters are folded. */
export function tagKey(path: string): string {
  return path.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

interface TagRow {
  id: number;
  parent_id: number | null;
  name: string;
  path: string;
  file_count: number;
}

function prepareStatements(db: Db) {
  return {
    list: db.prepare<[], TagRow>(`
      SELECT t.id, t.parent_id, t.name, t.path,
             (SELECT COUNT(*) FROM file_tags ft WHERE ft.tag_id = t.id) AS file_count
      FROM tags t
      ORDER BY t.path COLLATE NOCASE`),
    byPath: db.prepare<[string], TagRef>('SELECT id, path FROM tags WHERE path = ?'),
    insert: db.prepare<[number | null, string, string, number]>(
      'INSERT INTO tags (parent_id, name, path, created_at) VALUES (?, ?, ?, ?)',
    ),
    attach: db.prepare<[number, string]>(`
      INSERT OR IGNORE INTO file_tags (file_id, tag_id)
      SELECT f.id, ? FROM files f WHERE f.id IN (SELECT value FROM json_each(?))`),
    copy: db.prepare<[string, string]>(`
      INSERT OR IGNORE INTO file_tags (file_id, tag_id)
      SELECT target.value, ft.tag_id
      FROM json_each(?) target, file_tags ft
      WHERE ft.file_id IN (SELECT value FROM json_each(?))`),
    detach: db.prepare<[string, string]>(`
      DELETE FROM file_tags
      WHERE tag_id IN (SELECT value FROM json_each(?)) AND file_id IN (SELECT value FROM json_each(?))`),
    forFile: db.prepare<[number], TagRef>(`
      SELECT t.id, t.path FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id = ?
      ORDER BY t.path COLLATE NOCASE`),
    pathsForFiles: db.prepare<[string], { fileId: number; path: string }>(`
      SELECT ft.file_id AS fileId, t.path FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id IN (SELECT value FROM json_each(?))
      ORDER BY ft.file_id, t.path COLLATE NOCASE`),
    forSelection: db.prepare<[string], TagUsage>(`
      SELECT t.id, t.path, COUNT(*) AS fileCount
      FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id IN (SELECT value FROM json_each(?))
      GROUP BY t.id
      ORDER BY t.path COLLATE NOCASE`),
    count: db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM tags'),
    // Walks the primary key: no temporary B-tree for DISTINCT.
    taggedFileCount: db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM (SELECT DISTINCT file_id FROM file_tags)',
    ),
    pruneUnused: db.prepare<[]>(`
      DELETE FROM tags
      WHERE NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.tag_id = tags.id)
        AND NOT EXISTS (SELECT 1 FROM tags child WHERE child.parent_id = tags.id)`),
  };
}

/** Hierarchical tags. A tag exists only while a file or a descendant tag uses it. */
export class TagsRepository {
  private readonly db: Db;
  private readonly statements: ReturnType<typeof prepareStatements>;

  constructor(db: Db) {
    this.db = db;
    this.statements = prepareStatements(db);
  }

  list(): Tag[] {
    return this.statements.list.all().map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      name: row.name,
      path: row.path,
      fileCount: row.file_count,
    }));
  }

  /**
   * Tags `fileIds` with each of `tagPaths`, creating missing tags (and their ancestors). Returns
   * the number of tags added, counted once per file: tags a file already has are not.
   */
  addToFiles(fileIds: readonly number[], tagPaths: readonly string[]): number {
    const files = jsonIds(fileIds);
    return this.db.transaction(() => {
      let added = 0;
      for (const input of tagPaths) {
        const path = normalizeTagPath(input);
        if (path !== null) {
          added += this.statements.attach.run(this.ensure(path), files).changes;
        }
      }
      return added;
    })();
  }

  /** Gives each of `toIds` every tag that one of `fromIds` has. */
  copyTags(fromIds: readonly number[], toIds: readonly number[]): void {
    this.statements.copy.run(jsonIds(toIds), jsonIds(fromIds));
  }

  removeFromFiles(fileIds: readonly number[], tagIds: readonly number[]): void {
    this.db.transaction(() => {
      this.statements.detach.run(jsonIds(tagIds), jsonIds(fileIds));
      this.pruneUnused();
    })();
  }

  forFile(fileId: number): TagRef[] {
    return this.statements.forFile.all(fileId);
  }

  forSelection(fileIds: readonly number[]): TagUsage[] {
    return this.statements.forSelection.all(jsonIds(fileIds));
  }

  /** The tag paths of each of `fileIds`, sorted as `list()` sorts them; untagged files left out. */
  pathsForFiles(fileIds: readonly number[]): Map<number, string[]> {
    const paths = new Map<number, string[]>();
    for (const { fileId, path } of this.statements.pathsForFiles.all(jsonIds(fileIds))) {
      const list = paths.get(fileId);
      if (list) {
        list.push(path);
      } else {
        paths.set(fileId, [path]);
      }
    }
    return paths;
  }

  count(): number {
    return this.statements.count.get()?.count ?? 0;
  }

  /** Files, present or missing, that have at least one tag. */
  taggedFileCount(): number {
    return this.statements.taggedFileCount.get()?.count ?? 0;
  }

  /** Deletes unused leaf tags, repeatedly, so emptied branches disappear too. */
  pruneUnused(): void {
    while (this.statements.pruneUnused.run().changes > 0) {
      // Each pass may turn parents into unused leaves.
    }
  }

  /** Returns the id of the tag at `path`, creating it and its ancestors as needed. */
  private ensure(path: string): number {
    let parentId: number | null = null;
    let parentPath = '';
    for (const segment of path.split('/')) {
      // Build on the stored spelling of existing ancestors: tags are unique case-insensitively.
      const candidate = parentId === null ? segment : `${parentPath}/${segment}`;
      const existing = this.statements.byPath.get(candidate);
      if (existing) {
        parentId = existing.id;
        parentPath = existing.path;
      } else {
        const inserted = this.statements.insert.run(parentId, segment, candidate, Date.now());
        parentId = Number(inserted.lastInsertRowid);
        parentPath = candidate;
      }
    }
    if (parentId === null) {
      throw new Error(`Invalid tag path "${path}"`);
    }
    return parentId;
  }
}
