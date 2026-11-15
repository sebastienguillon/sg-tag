import type { Settings, SortDirection, SortField, SortOrder, TagExportRecord } from '@shared/model';
import { DEFAULT_SETTINGS, SIDEBAR_WIDTH, TILE_SIZE } from '@shared/model';
import type { Db } from '../database/database';

const SORT_FIELDS: readonly SortField[] = ['modified', 'name', 'size'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];
const LAST_TAG_EXPORT = 'lastTagExport';
const CATALOGUE_FILE = 'catalogueFile';

function prepareStatements(db: Db) {
  return {
    all: db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings'),
    value: db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?'),
    upsert: db.prepare<[string, string]>(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ),
    remove: db.prepare<[string]>('DELETE FROM settings WHERE key = ?'),
  };
}

/** User preferences, stored as one JSON value per key and validated on the way in and out. */
export class SettingsRepository {
  private readonly db: Db;
  private readonly statements: ReturnType<typeof prepareStatements>;

  constructor(db: Db) {
    this.db = db;
    this.statements = prepareStatements(db);
  }

  get(): Settings {
    const stored = new Map(
      this.statements.all.all().map(({ key, value }) => [key, JSON.parse(value) as unknown]),
    );
    return sanitize({
      tileSize: stored.get('tileSize'),
      sort: stored.get('sort'),
      sidebarWidth: stored.get('sidebarWidth'),
    });
  }

  update(patch: Partial<Settings>): Settings {
    const next = sanitize({ ...this.get(), ...patch });
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(next)) {
        this.statements.upsert.run(key, JSON.stringify(value));
      }
    })();
    return next;
  }

  /**
   * The latest tags export saved, if any; `update()` never writes it (its key is not a setting).
   */
  lastTagExport(): TagExportRecord | null {
    const row = this.statements.value.get(LAST_TAG_EXPORT);
    return row ? sanitizeTagExport(JSON.parse(row.value) as unknown) : null;
  }

  recordTagExport(record: TagExportRecord): void {
    const { at, path, files } = record;
    this.statements.upsert.run(LAST_TAG_EXPORT, JSON.stringify({ at, path, files }));
  }

  /**
   * The classification catalogue chosen, by its path, if any; `update()` never writes it (its key
   * is not a setting).
   */
  catalogueFile(): string | null {
    const row = this.statements.value.get(CATALOGUE_FILE);
    const value = row ? (JSON.parse(row.value) as unknown) : null;
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** Remembers the classification catalogue chosen; `null` forgets it. */
  recordCatalogueFile(path: string | null): void {
    if (path === null) {
      this.statements.remove.run(CATALOGUE_FILE);
    } else {
      this.statements.upsert.run(CATALOGUE_FILE, JSON.stringify(path));
    }
  }
}

function sanitizeTagExport(value: unknown): TagExportRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { at, path, files } = value as Record<string, unknown>;
  return Number.isSafeInteger(at) &&
    typeof path === 'string' &&
    path !== '' &&
    Number.isSafeInteger(files) &&
    (files as number) >= 0
    ? { at: at as number, path, files: files as number }
    : null;
}

function sanitize(input: { tileSize?: unknown; sort?: unknown; sidebarWidth?: unknown }): Settings {
  return {
    tileSize: sanitizeSize(input.tileSize, TILE_SIZE, DEFAULT_SETTINGS.tileSize),
    sort: sanitizeSort(input.sort),
    sidebarWidth: sanitizeSize(input.sidebarWidth, SIDEBAR_WIDTH, DEFAULT_SETTINGS.sidebarWidth),
  };
}

function sanitizeSize(
  value: unknown,
  range: { readonly min: number; readonly max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function sanitizeSort(value: unknown): SortOrder {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_SETTINGS.sort;
  }
  const { field, direction } = value as Record<string, unknown>;
  return SORT_FIELDS.includes(field as SortField) &&
    SORT_DIRECTIONS.includes(direction as SortDirection)
    ? { field: field as SortField, direction: direction as SortDirection }
    : DEFAULT_SETTINGS.sort;
}
