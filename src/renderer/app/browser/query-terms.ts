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

/** `query` without `term` if it holds it, else with `term` appended. */
export function toggleTerm(query: string, term: string): string {
  const wanted = term.toLowerCase();
  const current = terms(query);
  const kept = current.filter((t) => t.toLowerCase() !== wanted);
  return (kept.length < current.length ? kept : [...current, term]).join(' ');
}
