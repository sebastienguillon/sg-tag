import type { SortOrder } from '@shared/model';
import { extensionAliases } from '../library/formats';
import type { Clause } from './query-parser';

export interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

export interface QueryContext {
  readonly offlineRootIds: readonly number[];
}

const ORDER: Readonly<Record<SortOrder['field'], readonly string[]>> = {
  modified: ['f.mtime_ms', 'f.id'],
  name: ['f.name COLLATE NOCASE', 'f.id'],
  size: ['f.size', 'f.id'],
};

/** Files carrying a tag whose path contains `?` as whole segments, or a descendant of one. */
const TAG_MATCH = `(t.path = ? OR t.path LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\' OR t.path LIKE ? ESCAPE '\\')`;

/** Turns parsed clauses into one parameterised `SELECT f.id …` in display order. */
export function compileQuery(
  clauses: readonly Clause[],
  sort: SortOrder,
  context: QueryContext,
): CompiledQuery {
  const where: string[] = [];
  const params: (string | number)[] = [];

  const add = (sql: string, values: readonly (string | number)[], negated: boolean): void => {
    where.push(negated ? `NOT (${sql})` : sql);
    params.push(...values);
  };

  for (const clause of clauses) {
    switch (clause.type) {
      case 'text': {
        const like = `%${escapeLike(clause.value)}%`;
        const tagged = `f.id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.path LIKE ? ESCAPE '\\')`;
        // Trigram FTS needs at least 3 characters; shorter terms fall back to LIKE scans.
        if (codePoints(clause.value) >= 3) {
          add(
            `(f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?) OR ${tagged})`,
            [ftsPhrase(clause.value), like],
            clause.negated,
          );
        } else {
          add(
            `(f.name LIKE ? ESCAPE '\\' OR f.dir LIKE ? ESCAPE '\\' OR ${tagged})`,
            [like, like, like],
            clause.negated,
          );
        }
        break;
      }
      case 'tag': {
        const conditions = clause.paths.map(() => TAG_MATCH).join(' OR ');
        add(
          `f.id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ${conditions})`,
          clause.paths.flatMap(tagPatterns),
          clause.negated,
        );
        break;
      }
      case 'kind':
        add('f.kind = ?', [clause.kind], clause.negated);
        break;
      case 'ext': {
        const exts = [...new Set(clause.exts.flatMap(extensionAliases))];
        add(`f.ext IN (${exts.map(() => '?').join(', ')})`, exts, clause.negated);
        break;
      }
      case 'folder':
        add(`f.dir LIKE ? ESCAPE '\\'`, [`%${escapeLike(clause.value)}%`], clause.negated);
        break;
      case 'size': {
        const bounds: string[] = [];
        const values: number[] = [];
        if (clause.min !== null) {
          bounds.push('f.size >= ?');
          values.push(clause.min);
        }
        if (clause.max !== null) {
          bounds.push('f.size <= ?');
          values.push(clause.max);
        }
        add(bounds.join(' AND '), values, clause.negated);
        break;
      }
      case 'state':
        switch (clause.state) {
          case 'tagged':
            add('EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)', [], clause.negated);
            break;
          case 'untagged':
            add(
              'NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)',
              [],
              clause.negated,
            );
            break;
          case 'missing':
            add('f.missing_since IS NOT NULL', [], clause.negated);
            break;
          case 'offline': {
            const placeholders = context.offlineRootIds.map(() => '?').join(', ');
            add(
              `f.root_id IN (${placeholders === '' ? 'NULL' : placeholders})`,
              context.offlineRootIds,
              clause.negated,
            );
            break;
          }
        }
        break;
    }
  }

  // Files that vanished but are kept for their tags only show up when asked for.
  const wantsMissing = clauses.some(
    (clause) => clause.type === 'state' && clause.state === 'missing' && !clause.negated,
  );
  if (!wantsMissing) {
    where.unshift('f.missing_since IS NULL');
  }

  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  // Terms under 3 characters are LIKE scans over names and folders, which are not in the sort
  // indexes. Walking an index in display order would then cost one random row read per file; a
  // sequential scan plus sort is several times faster. Unary `+` keeps SQLite off the index.
  const scan = clauses.some((clause) => clause.type === 'text' && codePoints(clause.value) < 3);
  const orderBy = ORDER[sort.field]
    .map((column, index) => `${scan && index === 0 ? '+' : ''}${column} ${direction}`)
    .join(', ');
  return {
    sql: `SELECT f.id FROM files f${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}`,
    params,
  };
}

/** Length in Unicode code points, which is what the trigram tokenizer counts. */
function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** An FTS5 phrase matches the value as a contiguous substring with the trigram tokenizer. */
function ftsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tagPatterns(path: string): string[] {
  const escaped = escapeLike(path);
  return [path, `${escaped}/%`, `%/${escaped}`, `%/${escaped}/%`];
}
