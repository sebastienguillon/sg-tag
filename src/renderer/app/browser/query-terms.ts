import { BYTE_ORDER_MARK } from '@shared/tag-names';

/**
 * Search terms as the search bar splits them: on spaces, except inside quotes, and without the byte
 * order marks, which the search leaves out. Toolbar toggles use these to add or remove one term
 * while keeping the rest of the query as typed.
 */
function terms(query: string): string[] {
  return query.replaceAll(BYTE_ORDER_MARK, '').match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

/** Whether `query` holds `term`, ignoring case (`IS:Untagged` is `is:untagged`). */
export function hasTerm(query: string, term: string): boolean {
  const wanted = term.toLowerCase();
  return terms(query).some((t) => t.toLowerCase() === wanted);
}

/** Keys of the search syntax whose terms leave the names of tags alone (`is:untagged`). */
const OTHER_KEYS: ReadonlySet<string> = new Set([
  'type',
  'kind',
  'is',
  'ext',
  'format',
  'size',
  'in',
  'folder',
  'path',
]);

/**
 * Whether `query` holds a `tag:` term or free text: both compare the names and aliases of tags,
 * and find the tags below them too, so what they find changes with the names, aliases and parent
 * tags, though no file changed. A key is read as the search reads it: the text before the first
 * colon, when no quote comes before; a key the search does not know makes free text.
 */
export function holdsTagOrText(query: string): boolean {
  return terms(query).some((term) => {
    const key = /^-?([^":]+):/.exec(term)?.[1];
    return key === undefined || !OTHER_KEYS.has(key.toLowerCase());
  });
}

/** `query` without `term` if it holds it, else with `term` appended. */
export function toggleTerm(query: string, term: string): string {
  const wanted = term.toLowerCase();
  const current = terms(query);
  const kept = current.filter((t) => t.toLowerCase() !== wanted);
  return (kept.length < current.length ? kept : [...current, term]).join(' ');
}
