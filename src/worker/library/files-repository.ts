import type { FileDetails, FileKind, FileSummary } from '@shared/model';
import type { Db } from '../database/database';
import { jsonIds } from '../database/database';
import { formatOf } from './formats';
import { descendantRange } from './paths';

/** Values for `files.thumb_state`. */
export const ThumbState = {
  pending: 0,
  ready: 1,
  failed: 2,
  /** Needs the OS thumbnailer (main process). */
  system: 3,
} as const;
export type ThumbState = (typeof ThumbState)[keyof typeof ThumbState];

/** A file as seen on disk, ready to be written to the index. */
export interface FileRecord {
  readonly rootId: number;
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly ext: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number | null;
  readonly fileId: string | null;
}

/** What the indexer needs to know about an already indexed file. */
export interface IndexedFile {
  readonly id: number;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly fileId: string | null;
  readonly tagged: boolean;
  readonly missing: boolean;
}

export interface MissingCandidate {
  readonly id: number;
  readonly fileId: string | null;
  readonly mtimeMs: number;
  readonly fingerprint: string | null;
}

export interface FingerprintTarget {
  readonly id: number;
  readonly path: string;
  readonly size: number;
}

export interface ThumbInfo {
  readonly id: number;
  readonly rootId: number;
  readonly path: string;
  readonly ext: string;
  readonly kind: FileKind;
  readonly thumbState: ThumbState;
  readonly missing: boolean;
}

export interface MediaInfo {
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly codec: string | null;
}

interface IndexedRow {
  id: number;
  path: string;
  size: number;
  mtime_ms: number;
  file_id: string | null;
  tagged: number;
  missing: number;
}

interface SummaryRow {
  id: number;
  root_id: number;
  name: string;
  kind: FileKind;
  ext: string;
  size: number;
  mtime_ms: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}

interface DetailsRow extends SummaryRow {
  path: string;
  dir: string;
  root_path: string;
  birthtime_ms: number | null;
  codec: string | null;
  missing_since: number | null;
}

const INDEXED_COLUMNS = `
  f.id, f.path, f.size, f.mtime_ms, f.file_id,
  EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id) AS tagged,
  f.missing_since IS NOT NULL AS missing`;

const SUMMARY_COLUMNS = `
  f.id, f.root_id, f.name, f.kind, f.ext, f.size, f.mtime_ms, f.width, f.height, f.duration_ms`;

function prepareStatements(db: Db) {
  return {
    listForRoot: db.prepare<[number], IndexedRow>(
      `SELECT ${INDEXED_COLUMNS} FROM files f WHERE f.root_id = ?`,
    ),
    byPath: db.prepare<[string], IndexedRow>(
      `SELECT ${INDEXED_COLUMNS} FROM files f WHERE f.path = ?`,
    ),
    underDir: db.prepare<[string, string], IndexedRow>(
      `SELECT ${INDEXED_COLUMNS} FROM files f WHERE f.path > ? AND f.path < ? AND f.missing_since IS NULL`,
    ),
    insert: db.prepare<[FileRecordParams]>(`
      INSERT INTO files (root_id, path, dir, name, ext, kind, size, mtime_ms, birthtime_ms, file_id)
      VALUES (@rootId, @path, @dir, @name, @ext, @kind, @size, @mtimeMs, @birthtimeMs, @fileId)`),
    update: db.prepare<[FileRecordParams & { id: number; changed: number }]>(`
      UPDATE files SET
        root_id = @rootId, dir = @dir, name = @name, ext = @ext, kind = @kind,
        size = @size, mtime_ms = @mtimeMs, birthtime_ms = @birthtimeMs, file_id = @fileId,
        missing_since = NULL,
        fingerprint = CASE WHEN @changed THEN NULL ELSE fingerprint END,
        thumb_state = CASE WHEN @changed THEN 0 ELSE thumb_state END,
        width = CASE WHEN @changed THEN NULL ELSE width END,
        height = CASE WHEN @changed THEN NULL ELSE height END,
        duration_ms = CASE WHEN @changed THEN NULL ELSE duration_ms END,
        codec = CASE WHEN @changed THEN NULL ELSE codec END
      WHERE id = @id AND path = @path`),
    relocate: db.prepare<[FileRecordParams & { id: number }]>(`
      UPDATE files SET
        root_id = @rootId, path = @path, dir = @dir, name = @name, ext = @ext, kind = @kind,
        size = @size, mtime_ms = @mtimeMs, birthtime_ms = @birthtimeMs, file_id = @fileId,
        missing_since = NULL
      WHERE id = @id`),
    markMissing: db.prepare<[number, number]>(
      'UPDATE files SET missing_since = ? WHERE id = ? AND missing_since IS NULL',
    ),
    delete: db.prepare<[string]>('DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))'),
    missingBySize: db.prepare<[number], MissingCandidate>(`
      SELECT id, file_id AS fileId, mtime_ms AS mtimeMs, fingerprint FROM files
      WHERE size = ? AND missing_since IS NOT NULL`),
    hasMissing: db.prepare<[], { found: number }>(
      'SELECT EXISTS (SELECT 1 FROM files WHERE missing_since IS NOT NULL) AS found',
    ),
    setFingerprint: db.prepare<[string, number]>('UPDATE files SET fingerprint = ? WHERE id = ?'),
    needingFingerprint: db.prepare<[string], FingerprintTarget>(`
      SELECT f.id, f.path, f.size FROM files f
      WHERE f.id IN (SELECT value FROM json_each(?))
        AND f.fingerprint IS NULL AND f.missing_since IS NULL
        AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)`),
    summaries: db.prepare<[string], SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM files f WHERE f.id IN (SELECT value FROM json_each(?))`,
    ),
    details: db.prepare<[number], DetailsRow>(`
      SELECT ${SUMMARY_COLUMNS}, f.path, f.dir, r.path AS root_path, f.birthtime_ms, f.codec,
             f.missing_since
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.id = ?`),
    thumbInfo: db.prepare<[number], ThumbInfoRow>(`
      SELECT id, root_id, path, ext, kind, thumb_state, missing_since IS NOT NULL AS missing
      FROM files WHERE id = ?`),
    setThumb: db.prepare<[{ id: number; state: number } & MediaParams]>(`
      UPDATE files SET thumb_state = @state,
        width = COALESCE(@width, width), height = COALESCE(@height, height),
        duration_ms = COALESCE(@durationMs, duration_ms), codec = COALESCE(@codec, codec)
      WHERE id = @id`),
    setThumbState: db.prepare<[number, number]>('UPDATE files SET thumb_state = ? WHERE id = ?'),
    pending: db.prepare<[string, string, string, number], { id: number }>(`
      SELECT id FROM files
      WHERE thumb_state = 0 AND missing_since IS NULL AND kind = ?
        AND root_id NOT IN (SELECT value FROM json_each(?))
        AND id NOT IN (SELECT value FROM json_each(?))
      ORDER BY mtime_ms DESC
      LIMIT ?`),
    countPending: db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM files WHERE thumb_state = 0 AND missing_since IS NULL',
    ),
    count: db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM files WHERE missing_since IS NULL',
    ),
    pathOf: db.prepare<[number], { path: string }>('SELECT path FROM files WHERE id = ?'),
    idsForRoot: db.prepare<[number], { id: number }>('SELECT id FROM files WHERE root_id = ?'),
  };
}

/** Data access for the `files` table. Every method is synchronous (better-sqlite3). */
export class FilesRepository {
  private readonly db: Db;
  private readonly statements: ReturnType<typeof prepareStatements>;

  constructor(db: Db) {
    this.db = db;
    this.statements = prepareStatements(db);
  }

  /** All files indexed under a root (including missing ones), keyed by path. */
  listForRoot(rootId: number): Map<string, IndexedFile> {
    return new Map(
      this.statements.listForRoot.all(rootId).map((row) => [row.path, toIndexed(row)] as const),
    );
  }

  findByPath(path: string): IndexedFile | undefined {
    const row = this.statements.byPath.get(path);
    return row && toIndexed(row);
  }

  /** Present files strictly below `dir` (an absolute, native path). */
  listUnderDir(dir: string): IndexedFile[] {
    const [lower, upper] = descendantRange(dir);
    return this.statements.underDir.all(lower, upper).map(toIndexed);
  }

  insert(record: FileRecord): number {
    return Number(this.statements.insert.run(toParams(record)).lastInsertRowid);
  }

  /** Refreshes stats of a file found at its known path; `changed` drops derived data. */
  update(id: number, record: FileRecord, changed: boolean): void {
    this.statements.update.run({ ...toParams(record), id, changed: changed ? 1 : 0 });
  }

  /** Re-points a missing file to where it was found again, keeping its id, tags and thumbnail. */
  relocate(id: number, record: FileRecord): void {
    this.statements.relocate.run({ ...toParams(record), id });
  }

  markMissing(id: number, now: number): void {
    this.statements.markMissing.run(now, id);
  }

  delete(ids: readonly number[]): void {
    if (ids.length > 0) {
      this.statements.delete.run(jsonIds(ids));
    }
  }

  hasMissing(): boolean {
    return this.statements.hasMissing.get()?.found === 1;
  }

  missingCandidates(size: number): MissingCandidate[] {
    return this.statements.missingBySize.all(size);
  }

  setFingerprint(id: number, fingerprint: string): void {
    this.statements.setFingerprint.run(fingerprint, id);
  }

  needingFingerprint(ids: readonly number[]): FingerprintTarget[] {
    return this.statements.needingFingerprint.all(jsonIds(ids));
  }

  summaries(ids: readonly number[], offlineRoots: ReadonlySet<number>): FileSummary[] {
    return this.statements.summaries.all(jsonIds(ids)).map((row) => toSummary(row, offlineRoots));
  }

  details(id: number, offlineRoots: ReadonlySet<number>): Omit<FileDetails, 'tags'> | null {
    const row = this.statements.details.get(id);
    if (!row) {
      return null;
    }
    return {
      ...toSummary(row, offlineRoots),
      path: row.path,
      folder: row.dir,
      rootPath: row.root_path,
      birthtimeMs: row.birthtime_ms,
      codec: row.codec,
      missing: row.missing_since !== null,
    };
  }

  thumbInfo(id: number): ThumbInfo | null {
    const row = this.statements.thumbInfo.get(id);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      rootId: row.root_id,
      path: row.path,
      ext: row.ext,
      kind: row.kind,
      thumbState: row.thumb_state as ThumbState,
      missing: row.missing === 1,
    };
  }

  setThumb(id: number, state: ThumbState, media: MediaInfo | null = null): void {
    this.statements.setThumb.run({
      id,
      state,
      width: media?.width ?? null,
      height: media?.height ?? null,
      durationMs: media?.durationMs ?? null,
      codec: media?.codec ?? null,
    });
  }

  resetThumb(id: number): void {
    this.statements.setThumbState.run(ThumbState.pending, id);
  }

  /** Files still waiting for a thumbnail, newest first, skipping unreachable roots and `exclude`. */
  pendingThumbnails(
    kind: FileKind,
    offlineRoots: Iterable<number>,
    exclude: Iterable<number>,
    limit: number,
  ): number[] {
    return this.statements.pending
      .all(kind, jsonIds(offlineRoots), jsonIds(exclude), limit)
      .map((row) => row.id);
  }

  countPendingThumbnails(): number {
    return this.statements.countPending.get()?.count ?? 0;
  }

  count(): number {
    return this.statements.count.get()?.count ?? 0;
  }

  pathOf(id: number): string | null {
    return this.statements.pathOf.get(id)?.path ?? null;
  }

  idsForRoot(rootId: number): number[] {
    return this.statements.idsForRoot.all(rootId).map((row) => row.id);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

interface FileRecordParams {
  rootId: number;
  path: string;
  dir: string;
  name: string;
  ext: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  birthtimeMs: number | null;
  fileId: string | null;
}

interface MediaParams {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codec: string | null;
}

interface ThumbInfoRow {
  id: number;
  root_id: number;
  path: string;
  ext: string;
  kind: FileKind;
  thumb_state: number;
  missing: number;
}

function toParams(record: FileRecord): FileRecordParams {
  return { ...record };
}

function toIndexed(row: IndexedRow): IndexedFile {
  return {
    id: row.id,
    path: row.path,
    size: row.size,
    mtimeMs: row.mtime_ms,
    fileId: row.file_id,
    tagged: row.tagged === 1,
    missing: row.missing === 1,
  };
}

function toSummary(row: SummaryRow, offlineRoots: ReadonlySet<number>): FileSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    format: formatLabel(row.ext),
    size: row.size,
    mtimeMs: row.mtime_ms,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    offline: offlineRoots.has(row.root_id),
  };
}

function formatLabel(ext: string): string {
  return formatOf(ext)?.label ?? ext.toUpperCase();
}
