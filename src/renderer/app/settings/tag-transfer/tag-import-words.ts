import { formatNumber } from '@angular/common';

/** What applying a tags import adds, or added, as one sentence counts it. */
export interface ImportCounts {
  /** Tags added to files, counted once per file. */
  readonly assignments: number;
  /** Files that gain at least one tag. */
  readonly files: number;
  /** Tags made: those the tags export describes, and those only its files have. */
  readonly newTags: number;
  /** Aliases given to tags. */
  readonly aliases: number;
  /** Parent tags given to tags: once per tag and parent tag linked. */
  readonly links: number;
}

/** `1 tag`, `3,410 tags`: the number as the `number` pipe writes it. */
function counted(count: number, one: string, many: string, locale: string): string {
  return `${formatNumber(count, locale)} ${count === 1 ? one : many}`;
}

/**
 * What an import adds (`present`) or added (`past`), as a sentence without its subject and its full
 * stop: `adds 3 tags to 2 files, creates 4 new tags, and adds 2 aliases and 1 parent tag`. Empty
 * when it adds nothing.
 *
 * Built here rather than in the templates: each part may be missing, and the commas between them
 * depend on which are there, which whitespace in a template cannot say.
 */
export function importAdditions(
  counts: ImportCounts,
  tense: 'present' | 'past',
  locale: string,
): string {
  const [add, create] = tense === 'present' ? ['adds', 'creates'] : ['added', 'created'];
  const parts: string[] = [];
  if (counts.assignments > 0) {
    const tags = counted(counts.assignments, 'tag', 'tags', locale);
    parts.push(`${add} ${tags} to ${counted(counts.files, 'file', 'files', locale)}`);
  }
  if (counts.newTags > 0) {
    parts.push(`${create} ${counted(counts.newTags, 'new tag', 'new tags', locale)}`);
  }
  const given: string[] = [];
  if (counts.aliases > 0) {
    given.push(counted(counts.aliases, 'alias', 'aliases', locale));
  }
  if (counts.links > 0) {
    given.push(counted(counts.links, 'parent tag', 'parent tags', locale));
  }
  if (given.length > 0) {
    parts.push(`${add} ${given.join(' and ')}`);
  }
  const last = parts.pop();
  if (last === undefined) {
    return '';
  }
  // A comma before the last part too, as in `adds 3 tags to 2 files, and creates 4 new tags`.
  return parts.length === 0 ? last : `${parts.join(', ')}, and ${last}`;
}
