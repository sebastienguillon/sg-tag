/**
 * The rules for the names of tags, shared by the interface, the worker and the tags export so that
 * they cannot disagree: what a name may hold, when two names are the same tag, and how a search
 * term is compared with a name.
 *
 * A tag has one name and any number of aliases. Names and aliases share one namespace: each
 * resolves to exactly one tag.
 */

/** Longest name or alias, in UTF-16 units: also the longest a tags export holds. */
export const MAX_TAG_NAME_LENGTH = 1_024;
/**
 * Combining marks in a row in a name, at most, as UAX #15's Stream-Safe Text Format allows. NFC
 * sorts each run of them in a time that grows as the square of its length.
 */
export const MAX_TAG_MARK_RUN = 30;
/** Aliases of one tag, at most. */
export const MAX_TAG_ALIASES = 100;
/** Parent tags of one tag, at most. */
export const MAX_TAG_PARENTS = 100;

/**
 * A run of more than `MAX_TAG_MARK_RUN` marks, matched from the first mark of a run only: tried
 * from each of them, it takes longer than the normalisation it guards.
 */
const LONG_MARK_RUN = new RegExp(`(?<!\\p{M})\\p{M}{${MAX_TAG_MARK_RUN + 1}}`, 'u');
/** `codes` as one string, so that no invisible character is written in this file. */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);

/**
 * The left-to-right and right-to-left overrides, U+202D and U+202E: they draw the letters after
 * them in another order, so that a name would read as another (`x` and an override before `dcba`
 * reads `xabcd`). The other direction marks only place a whole name among the text around it.
 */
const OVERRIDES = new RegExp(`[${chars(0x202d, 0x202e)}]`, 'u');
/** Control characters and lone surrogates; tabs and line breaks are whitespace, collapsed before. */
const UNPRINTABLE = /[\p{Cc}\p{Cs}]/u;
/**
 * Characters that draw a blank and that JavaScript does not take for whitespace: the Hangul fillers
 * (U+115F, U+1160, U+3164, U+FFA0) and the blank Braille pattern (U+2800), which social networks
 * use as spaces. A comparison takes each run of them for a space.
 */
const BLANK_CHARACTERS = chars(0x115f, 0x1160, 0x2800, 0x3164, 0xffa0);
const BLANKS = new RegExp(`[${BLANK_CHARACTERS}]+`, 'gu');
/**
 * Something to see: not whitespace or a blank, not a format character (zero-width space,
 * joiner…), not a combining mark, which is drawn on the character before it and is nothing to read
 * by itself, and not one of the characters a comparison leaves out (`UNSEEN`).
 */
const VISIBLE = new RegExp(
  `[^\\s\\p{Cf}\\p{M}\\p{Default_Ignorable_Code_Point}${BLANK_CHARACTERS}]`,
  'u',
);
/** The byte order mark, U+FEFF: what a text file may start with, and whitespace to JavaScript. */
export const BYTE_ORDER_MARK = chars(0xfeff);
/** The black flag, U+1F3F4, that the flags of England, Scotland and Wales start with. */
const BLACK_FLAG = chars(0x1f3f4);
/**
 * A flag spelled with tag characters, as Unicode writes the flags of England, Scotland and Wales:
 * a black flag, tag digits and tag lower-case letters (U+E0030 to U+E0039, U+E0061 to U+E007A),
 * and a cancel tag (U+E007F). Anything else is drawn as the black flag alone.
 */
const SPELLED_FLAG = `${BLACK_FLAG}[${chars(0xe0030)}-${chars(0xe0039)}${chars(0xe0061)}-${chars(0xe007a)}]+${chars(0xe007f)}`;
/**
 * A spelled flag, or else a run of characters nobody sees: Unicode's default ignorable code points
 * (zero-width space and joiners, soft hyphen, word joiner, direction marks, variation selectors,
 * tag characters, Hangul fillers…) and the interlinear annotation characters (U+FFF9 to U+FFFB),
 * which are drawn as nothing either. The flag comes first, so that its letters are found with it
 * and not as a run of their own.
 */
const UNSEEN = new RegExp(
  `${SPELLED_FLAG}|[\\p{Default_Ignorable_Code_Point}${chars(0xfff9)}-${chars(0xfffb)}]+`,
  'gu',
);
/** A run of whitespace and of characters nobody sees, which `tagNameText` looks through. */
const SPACING = /[\s\p{Default_Ignorable_Code_Point}]+/gu;
/** The accents of Latin, Greek and Cyrillic letters, once decomposed. */
const ACCENTS = /[\u0300-\u036f]+/g;

/** Why a name or an alias is refused. */
export type TagNameProblem =
  /**
   * Nothing to see is left once whitespace, format characters and combining marks are taken away:
   * a name of accents alone is refused like a name of spaces.
   */
  | 'empty'
  /** A comma separates tags, in the tag input and in `tag:a,b`. */
  | 'comma'
  /** A double quote delimits a search term and cannot be written inside one. */
  | 'quote'
  /** A leading `=` means "this tag itself" in a search: `tag:=France`. */
  | 'equals'
  /** A control character, or an override that draws the letters after it in another order. */
  | 'control'
  /** Longer than `MAX_TAG_NAME_LENGTH`. */
  | 'tooLong'
  /** A run of more than `MAX_TAG_MARK_RUN` combining marks. */
  | 'marks';

export type TagNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly problem: TagNameProblem };

/**
 * The first step of the rule, without its checks: `input` written as a name is stored, in Unicode
 * NFC, its whitespace collapsed to single spaces and trimmed. For a text that is compared with
 * names and need not be one, such as a search term; a name goes through `normalizeTagName`.
 *
 * A byte order mark is left out: nobody sees it, and JavaScript takes it for whitespace, so one
 * pasted inside a word would cut the word in two. Whitespace is collapsed and trimmed through the
 * other characters nobody sees, which stay where they are: a direction mark before a space at the
 * start, or a zero-width space between two spaces, keeps no space that would be seen.
 *
 * Unlike `normalizeTagName`, it composes whatever it is given: NFC takes long on thousands of
 * combining marks in a row.
 */
export function tagNameText(input: string): string {
  return input
    .replaceAll(BYTE_ORDER_MARK, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(SPACING, (run: string, offset: number, text: string) => {
      const space = run.indexOf(' ');
      if (space === -1) {
        return run;
      }
      const unseen = run.replaceAll(' ', '');
      // At an edge no space is kept; inside, the first one, where it stood among the others.
      return offset === 0 || offset + run.length === text.length
        ? unseen
        : `${unseen.slice(0, space)} ${unseen.slice(space)}`;
    });
}

/**
 * `text` as a name is compared: without the characters nobody sees (`UNSEEN`), in one pass over
 * it, with each run of blanks taken for a space, and with its whitespace collapsed and trimmed as
 * whitespace is in a name, so that a space no longer counts for having one of them beside it. The
 * tag characters that spell a flag stay: without them the flags of England, Scotland and Wales are
 * one black flag.
 *
 * It does not compose: it can be run on a text before it is known to be short enough for that.
 */
export function withoutUnseen(text: string): string {
  return text
    .replace(BLANKS, ' ')
    .replace(UNSEEN, (found) => (found.startsWith(BLACK_FLAG) ? found : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A name or an alias as it is stored (`tagNameText`): Unicode NFC, whitespace collapsed to single
 * spaces and trimmed. `/` is an ordinary character. Says why when the name cannot be one.
 *
 * Every name that passes fits a tags export and can be written as a `tag:` search term.
 */
export function normalizeTagName(input: string): TagNameCheck {
  // As written, before normalising: NFC makes a text up to 3 times as long and is slow on long runs
  // of marks, so neither is given the chance.
  if (input.length > MAX_TAG_NAME_LENGTH) {
    return { ok: false, problem: 'tooLong' };
  }
  // Also as it is compared: the key leaves out the characters nobody sees, so the runs they part
  // are one run in it, and a byte order mark, one of them, is gone from the stored name itself.
  if (LONG_MARK_RUN.test(input) || LONG_MARK_RUN.test(withoutUnseen(input))) {
    return { ok: false, problem: 'marks' };
  }
  const name = tagNameText(input);
  const compared = withoutUnseen(name);
  // Again once normalised: NFC writes a few marks as two (the Greek dialytika tonos, some Tibetan
  // vowel signs), so a run short enough as typed can be too long as stored, and the name would be
  // refused when it is read back from a tags export.
  if (LONG_MARK_RUN.test(name) || LONG_MARK_RUN.test(compared)) {
    return { ok: false, problem: 'marks' };
  }
  if (!VISIBLE.test(name)) {
    return { ok: false, problem: 'empty' };
  }
  if (name.length > MAX_TAG_NAME_LENGTH) {
    return { ok: false, problem: 'tooLong' };
  }
  if (UNPRINTABLE.test(name) || OVERRIDES.test(name)) {
    return { ok: false, problem: 'control' };
  }
  if (name.includes(',')) {
    return { ok: false, problem: 'comma' };
  }
  if (name.includes('"')) {
    return { ok: false, problem: 'quote' };
  }
  // Whatever nobody sees before it: the name would be compared as one that starts with `=`.
  if (compared.startsWith('=')) {
    return { ok: false, problem: 'equals' };
  }
  return { ok: true, name };
}

/**
 * What makes two names the same tag: letter case never does (`Été`, `été` and `ÉTÉ` are one tag),
 * accents do (`côte` and `côté` are two). Takes a name already normalised (`normalizeTagName`).
 *
 * Characters nobody sees never do either (`UNSEEN`): a name pasted from a web page with a
 * zero-width space or a soft hyphen in it is the tag of the name as it reads, and a blank pasted
 * as a space is a space (`BLANKS`). A name is stored as it was typed all the same, as some of
 * these characters shape the letters around them (Persian, the scripts of India) or join several
 * emoji into one: only the comparison leaves them out. So a heart drawn in colour and the same
 * heart drawn as text are one tag, and so are a family emoji and its members side by side.
 *
 * Lower-casing must not depend on where a word ends. JavaScript writes a Greek capital sigma as a
 * final sigma (U+03C2) at the end of a word and as a sigma (U+03C3) elsewhere, so the key writes
 * the final sigma as a sigma. A name in capitals, in lower case with a final sigma and in lower
 * case with a plain sigma is then one tag, and a search finds a name from its first letters
 * wherever the text typed so far stops.
 */
export function tagKey(name: string): string {
  // Lower-casing is the same in every locale here, unlike `toLocaleLowerCase` (Turkish `I`).
  return withoutUnseen(name).toLowerCase().replaceAll('\u03c2', '\u03c3').normalize('NFC');
}

/**
 * What a search compares: `tagKey` without the accents of Latin, Greek and Cyrillic letters, so
 * that `ete` finds `Été` as it finds a file named `Été.jpg`. Other scripts keep their marks, which
 * are part of their letters. Takes a name, or a text written as one is (`tagNameText`).
 */
export function tagFold(name: string): string {
  // Collapsed and trimmed again: an accent typed on a space leaves that space beside another one,
  // or at an edge, and `a b` would not find `a`, a space with an accent, `b`.
  return tagKey(name)
    .normalize('NFD')
    .replace(ACCENTS, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The search term that finds the files of the tag named `name` and of the tags below it; with
 * `exact`, of that tag itself only. Quoted when the name holds whitespace: a valid name holds
 * neither a double quote nor a comma, so nothing else needs care.
 */
export function tagTerm(name: string, exact = false): string {
  const value = `${exact ? '=' : ''}${name}`;
  return /\s/.test(value) ? `tag:"${value}"` : `tag:${value}`;
}

/** A sentence for a refused name, fit to show under the field it was typed in. */
export function describeTagNameProblem(problem: TagNameProblem): string {
  switch (problem) {
    case 'empty':
      return 'A tag needs a name.';
    case 'comma':
      return 'A tag cannot contain a comma: commas separate tags.';
    case 'quote':
      return 'A tag cannot contain a double quote.';
    case 'equals':
      return 'A tag cannot start with “=”.';
    case 'control':
      return 'A tag cannot contain control characters.';
    case 'tooLong':
      return `A tag cannot be longer than ${MAX_TAG_NAME_LENGTH.toLocaleString('en')} characters.`;
    case 'marks':
      return 'A tag cannot contain this many combining marks in a row.';
  }
}
