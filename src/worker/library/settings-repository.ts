import type { Settings, SortDirection, SortField, SortOrder } from '@shared/model';
import { DEFAULT_SETTINGS, TILE_SIZE } from '@shared/model';
import type { Db } from '../database/database';

const SORT_FIELDS: readonly SortField[] = ['modified', 'name', 'size'];
const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

function prepareStatements(db: Db) {
  return {
    all: db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings'),
    upsert: db.prepare<[string, string]>(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ),
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
    return sanitize({ tileSize: stored.get('tileSize'), sort: stored.get('sort') });
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
}

function sanitize(input: { tileSize?: unknown; sort?: unknown }): Settings {
  return {
    tileSize: sanitizeTileSize(input.tileSize),
    sort: sanitizeSort(input.sort),
  };
}

function sanitizeTileSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.tileSize;
  }
  return Math.min(TILE_SIZE.max, Math.max(TILE_SIZE.min, Math.round(value)));
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
