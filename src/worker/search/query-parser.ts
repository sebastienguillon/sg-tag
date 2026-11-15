import type { FileKind } from '@shared/model';
import { BYTE_ORDER_MARK, tagNameText, withoutUnseen } from '@shared/tag-names';

export type FileState = 'tagged' | 'untagged' | 'missing' | 'offline' | 'duplicate';

/** One of the names of a `tag:` term. */
export interface TagName {
  /**
   * The name or an alias of a tag as typed, written as a stored name is: composed (NFC), its
   * whitespace collapsed. A search compares it without letter case, accents or characters nobody
   * sees (`tagFold`).
   */
  readonly name: string;
  /** `tag:=Name`: the tag itself, without the tags below it. */
  readonly exact: boolean;
}

/** One search term. Terms are AND-ed; comma-separated values inside a term are OR-ed. */
export type Clause =
  | { readonly type: 'text'; readonly value: string; readonly negated: boolean }
  | { readonly type: 'tag'; readonly names: readonly TagName[]; readonly negated: boolean }
  | { readonly type: 'kind'; readonly kind: FileKind; readonly negated: boolean }
  | { readonly type: 'ext'; readonly exts: readonly string[]; readonly negated: boolean }
  | { readonly type: 'folder'; readonly value: string; readonly negated: boolean }
  | {
      readonly type: 'size';
      readonly min: number | null;
      readonly max: number | null;
      readonly negated: boolean;
    }
  | { readonly type: 'state'; readonly state: FileState; readonly negated: boolean };

interface Token {
  readonly negated: boolean;
  /** Present when the token is `key:value` with an unquoted key. */
  readonly key: string | null;
  readonly value: string;
  /** The token as typed (minus the leading `-`), used when an unknown key falls back to text. */
  readonly raw: string;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  tag: 'tag',
  tags: 'tag',
  t: 'tag',
  type: 'type',
  kind: 'type',
  is: 'is',
  ext: 'ext',
  format: 'ext',
  size: 'size',
  in: 'folder',
  folder: 'folder',
  path: 'folder',
};

/**
 * Parses the search bar syntax. Incomplete terms (`tag:`, `tag:=`, `size:>`) are ignored rather
 * than reported, because the query is re-run on every keystroke.
 *
 *   beach "summer trip" tag:Japan,"New York" tag:=France -tag:draft
 *   type:video ext:jpg,png size:>10mb is:untagged
 *
 * `tag:France` is the tag France and every tag below it, `tag:=France` the tag France itself. The
 * `=` counts for the name it comes before, not for the whole list: `tag:=France,Paris`. Nothing
 * else is special in the name of a tag: `/` is an ordinary character.
 */
export function parseQuery(input: string): Clause[] {
  // A byte order mark is left out before the terms are split, as it is left out of a name
  // (`tagNameText`): nobody sees it, and JavaScript takes it for whitespace, so one pasted inside a
  // term would end the term there.
  return tokenize(input.replaceAll(BYTE_ORDER_MARK, '')).flatMap((token) => {
    const clause = toClause(token);
    return clause ? [clause] : [];
  });
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && isSpace(input.charAt(index))) {
      index++;
    }
    if (index >= input.length) {
      break;
    }
    let negated = false;
    if (
      input.charAt(index) === '-' &&
      index + 1 < input.length &&
      !isSpace(input.charAt(index + 1))
    ) {
      negated = true;
      index++;
    }
    let value = '';
    let raw = '';
    let key: string | null = null;
    let quoted = false;
    let sawQuote = false;
    while (index < input.length && (quoted || !isSpace(input.charAt(index)))) {
      const char = input.charAt(index);
      raw += char;
      if (char === '"') {
        quoted = !quoted;
        sawQuote = true;
      } else if (char === ':' && key === null && !quoted && !sawQuote && value !== '') {
        key = value.toLowerCase();
        value = '';
      } else {
        value += char;
      }
      index++;
    }
    tokens.push({ negated, key, value, raw });
  }
  return tokens;
}

function toClause(token: Token): Clause | null {
  const { negated, key } = token;
  const field = key === null ? undefined : KEY_ALIASES[key];
  // The token as typed is composed only where it is returned: composing takes long on a long run
  // of combining marks, and every other token is read from its value alone.
  if (key !== null && field === undefined) {
    return text(token.raw.normalize('NFC'), negated);
  }
  // Normalised only now that the syntax is read, and a tag term later still: see `tagName`.
  const value = field === 'tag' ? token.value : token.value.normalize('NFC');
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  switch (field) {
    case undefined:
      return text(trimmed, negated);
    case 'tag': {
      const names = list(trimmed).flatMap((item) => {
        const name = tagName(item);
        return name ? [name] : [];
      });
      return names.length > 0 ? { type: 'tag', names, negated } : null;
    }
    case 'type':
    case 'is':
      return keyword(trimmed.toLowerCase(), negated);
    case 'ext': {
      const exts = list(trimmed.toLowerCase()).map((ext) => ext.replace(/^\./, ''));
      return exts.length > 0 ? { type: 'ext', exts, negated } : null;
    }
    case 'folder':
      return { type: 'folder', value: trimmed.replaceAll('\\', '/'), negated };
    case 'size': {
      const range = parseSizeRange(trimmed);
      return range ? { type: 'size', ...range, negated } : null;
    }
    default:
      // A key that every object has, `constructor` or `__proto__`: not one of the search syntax
      // either, though the table above answers something for it.
      return text(token.raw.normalize('NFC'), negated);
  }
}

function keyword(value: string, negated: boolean): Clause | null {
  switch (value) {
    case 'image':
    case 'images':
    case 'photo':
    case 'photos':
      return { type: 'kind', kind: 'image', negated };
    case 'video':
    case 'videos':
    case 'movie':
    case 'movies':
      return { type: 'kind', kind: 'video', negated };
    case 'tagged':
    case 'untagged':
    case 'missing':
    case 'offline':
      return { type: 'state', state: value, negated };
    case 'duplicate':
    case 'duplicates':
      return { type: 'state', state: 'duplicate', negated };
    default:
      return null;
  }
}

function text(value: string, negated: boolean): Clause | null {
  return value === '' ? null : { type: 'text', value, negated };
}

/**
 * One name of a `tag:` term, from what was typed; `null` when nothing is left of it without its
 * `=`.
 *
 * The `=` is read before the name is normalised: NFC makes one character, `≠`, of an `=` and the
 * combining solidus a name may start with, and the `=` would no longer be seen. It is read through
 * the characters nobody sees, as a name that starts with one of them and an `=` is refused.
 */
function tagName(item: string): TagName | null {
  const exact = withoutUnseen(item).startsWith('=');
  // The first step of the rule for names, without its checks: a term that cannot be the name of a
  // tag is compared like any other, and finds a tag only when it folds to one of its names.
  const name = tagNameText(exact ? item.slice(item.indexOf('=') + 1) : item);
  return name === '' ? null : { name, exact };
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1e3,
  kb: 1e3,
  m: 1e6,
  mb: 1e6,
  g: 1e9,
  gb: 1e9,
  t: 1e12,
  tb: 1e12,
};

/** Sizes use decimal units (1 MB = 1,000,000 bytes), like the sizes displayed in the app. */
export function parseSize(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
  const unit = match ? UNITS[(match[2] ?? '').toLowerCase()] : undefined;
  if (!match || unit === undefined) {
    return null;
  }
  return Math.round(Number(match[1]) * unit);
}

/** `>10mb`, `>=10mb`, `<1gb`, `<=1gb`, `10mb..1gb`, or `10mb` (at least). */
export function parseSizeRange(value: string): { min: number | null; max: number | null } | null {
  const between = /^(.+)\.\.(.+)$/.exec(value);
  if (between) {
    const min = parseSize(between[1] ?? '');
    const max = parseSize(between[2] ?? '');
    return min !== null && max !== null ? { min, max } : null;
  }
  const comparison = /^(>=|<=|>|<)?(.+)$/.exec(value);
  const operator = comparison?.[1] ?? '>=';
  const size = parseSize(comparison?.[2] ?? '');
  if (size === null) {
    return null;
  }
  switch (operator) {
    case '>':
      return { min: size + 1, max: null };
    case '<':
      return { min: null, max: size - 1 };
    case '<=':
      return { min: null, max: size };
    default:
      return { min: size, max: null };
  }
}
