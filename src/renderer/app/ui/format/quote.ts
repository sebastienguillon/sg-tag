/**
 * A name is quoted in a sentence up to this length, in UTF-16 units: what was typed or pasted may
 * be a paragraph.
 */
const QUOTED_LENGTH = 60;

/** `name` as a sentence quotes it: whole, or its start when it is long. */
export function quote(name: string): string {
  if (name.length <= QUOTED_LENGTH) {
    return name;
  }
  // Without the half of a surrogate pair that a cut through it leaves.
  return `${name.slice(0, QUOTED_LENGTH).replace(/\p{Cs}$/u, '')}…`;
}
