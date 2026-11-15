import type { SortOrder } from '@shared/model';
import { tagFold, tagNameText, withoutUnseen } from '@shared/tag-names';
import { HAS_COPY } from '../library/files-repository';
import { extensionAliases } from '../library/formats';
import type { Clause, TagName } from './query-parser';

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

/**
 * The tags that have a name or an alias among the folds bound as one JSON array (`jsonFolds`): one
 * parameter whatever the number of names, so that the text of the statement does not change with
 * it and `SearchService` prepares it once.
 */
const TAGS_NAMED = 'SELECT tag_id FROM tag_names WHERE fold IN (SELECT value FROM json_each(?))';

/** The tags that have a name or an alias whose fold matches the pattern bound (`tagPattern`). */
const TAGS_NAMED_LIKE = `SELECT tag_id FROM tag_names WHERE fold LIKE ? ESCAPE '\\'`;

/**
 * The tags that `tags` selects, and every tag below one of them.
 *
 * `UNION`, never `UNION ALL`: it keeps each tag once. That is what ends the walk should parent
 * links ever form a loop, and a tag reached through two parents is not walked twice.
 */
function withTagsBelow(tags: string): string {
  return (
    `WITH RECURSIVE matched(id) AS (${tags} UNION ` +
    'SELECT tp.tag_id FROM tag_parents tp JOIN matched m ON tp.parent_id = m.id) ' +
    'SELECT id FROM matched'
  );
}

/**
 * The condition on a file `f`: it carries one of the tags that `tags` selects.
 *
 * Nothing in the subquery refers to the file, on purpose: SQLite then builds the set of files once
 * per statement, the walk through the tags below included, and looks each file up in it. A
 * subquery that names the file (an `EXISTS` on the tags of each file) is run for every file of the
 * library instead, which is slow.
 */
function carries(tags: string): string {
  return `f.id IN (SELECT ft.file_id FROM file_tags ft WHERE ft.tag_id IN (${tags}))`;
}

/** `tag:Name`: the file carries a tag with one of the names bound, or a tag below one. */
const TAGGED_OR_BELOW = carries(withTagsBelow(TAGS_NAMED));
/** `tag:=Name`: the file carries a tag with one of the names bound, itself. */
const TAGGED_EXACTLY = carries(TAGS_NAMED);
/** Free text: the file carries a tag whose name or alias contains the text, or a tag below one. */
const TAGGED_LIKE = carries(withTagsBelow(TAGS_NAMED_LIKE));

/** Turns parsed clauses into one parameterised `SELECT f.id …` in display order. */
export function compileQuery(
  clauses: readonly Clause[],
  sort: SortOrder,
  context: QueryContext,
): CompiledQuery {
  const where: string[] = [];
  const params: (string | number)[] = [];
  /** A text is searched by `LIKE` scans over names and folders: see the order below. */
  let scan = false;

  const add = (sql: string, values: readonly (string | number)[], negated: boolean): void => {
    where.push(negated ? `NOT (${sql})` : sql);
    params.push(...values);
  };

  for (const clause of clauses) {
    switch (clause.type) {
      case 'text': {
        const conditions: string[] = [];
        const values: string[] = [];
        for (const text of fileTexts(clause.value)) {
          // Trigram FTS needs at least 3 characters; shorter terms fall back to LIKE scans.
          if (codePoints(text) >= 3) {
            conditions.push('f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)');
            values.push(ftsPhrase(text));
          } else {
            const like = `%${escapeLike(text)}%`;
            conditions.push(`f.name LIKE ? ESCAPE '\\' OR f.dir LIKE ? ESCAPE '\\'`);
            values.push(like, like);
            scan = true;
          }
        }
        add(
          `(${conditions.join(' OR ')} OR ${TAGGED_LIKE})`,
          [...values, tagPattern(clause.value)],
          clause.negated,
        );
        break;
      }
      case 'tag': {
        // The names with `=` find their own tag, the others the tags below it too: a term that has
        // both finds the files of either.
        const sets = [
          { sql: TAGGED_OR_BELOW, names: clause.names.filter((name) => !name.exact) },
          { sql: TAGGED_EXACTLY, names: clause.names.filter((name) => name.exact) },
        ].filter((set) => set.names.length > 0);
        add(
          `(${sets.map((set) => set.sql).join(' OR ')})`,
          sets.map((set) => jsonFolds(set.names)),
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
            // Untagged files that vanished are only kept a while, in case they moved.
            add(
              'f.missing_since IS NOT NULL AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)',
              [],
              clause.negated,
            );
            break;
          case 'duplicate':
            add(HAS_COPY, [], clause.negated);
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

  // Copies side by side, largest first: the order that matters when deciding what to keep.
  const groupCopies = clauses.some(
    (clause) => clause.type === 'state' && clause.state === 'duplicate' && !clause.negated,
  );

  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  // Terms under 3 characters are LIKE scans over names and folders, which are not in the sort
  // indexes. Walking an index in display order would then cost one random row read per file; a
  // sequential scan plus sort is several times faster. Unary `+` keeps SQLite off the index.
  const orderBy = [
    ...(groupCopies ? ['f.size DESC', 'f.content_hash'] : []),
    ...ORDER[sort.field].map(
      (column, index) => `${scan && index === 0 ? '+' : ''}${column} ${direction}`,
    ),
  ].join(', ');
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

/**
 * What the names of files and folders are searched for: `text` as it is compared with the names of
 * tags, without the characters nobody sees and with its whitespace collapsed, and as typed too when
 * that differs: a name on disk may hold such a character itself (an emoji joined by a zero-width
 * joiner). A text made of such characters alone is searched as typed.
 */
function fileTexts(text: string): string[] {
  const seen = withoutUnseen(text).normalize('NFC');
  return seen === '' || seen === text ? [text] : [seen, text];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** An FTS5 phrase matches the value as a contiguous substring with the trigram tokenizer. */
function ftsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * The names of a `tag:` term as one JSON parameter for `TAGS_NAMED`, each as `tag_names.fold` holds
 * a name: without letter case, accents or characters nobody sees.
 */
function jsonFolds(names: readonly TagName[]): string {
  return JSON.stringify(names.map(({ name }) => tagFold(name)));
}

/**
 * The `LIKE` pattern for `TAGS_NAMED_LIKE`: the names and aliases that contain `text`, compared as
 * `tag_names.fold` holds a name, whose whitespace is collapsed.
 */
function tagPattern(text: string): string {
  const fold = tagFold(tagNameText(text));
  // Accents alone fold to nothing, which every name contains: such a text finds no tag, as no name
  // is made of accents alone, rather than every tag.
  return fold === '' ? '' : `%${escapeLike(fold)}%`;
}
