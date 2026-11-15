import { describe, expect, it, vi } from 'vitest';
import type { TagNameProblem } from './tag-names';
import {
  describeTagNameProblem,
  MAX_TAG_MARK_RUN,
  MAX_TAG_NAME_LENGTH,
  normalizeTagName,
  tagFold,
  tagKey,
  tagNameText,
  tagTerm,
} from './tag-names';

/** Why `input` cannot be a name; `null` when it can. */
function problemOf(input: string): TagNameProblem | null {
  const check = normalizeTagName(input);
  return check.ok ? null : check.problem;
}

/** The name `input` is stored as; `null` when it cannot be one. */
function storedAs(input: string): string | null {
  const check = normalizeTagName(input);
  return check.ok ? check.name : null;
}

/** A man, a woman and a girl held together by zero-width joiners: one emoji of 8 UTF-16 units. */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

describe('normalizeTagName', () => {
  it('stores a name composed, however it is typed', () => {
    expect(storedAs('E\u0301te\u0301')).toBe('\u00C9t\u00E9');
    expect(storedAs('\u00C9t\u00E9')).toBe('\u00C9t\u00E9');
    // Composed, and no more: a ligature and a superscript stay what they are.
    expect(storedAs('\uFB01n x\u00B2')).toBe('\uFB01n x\u00B2');
    // Marks are put in their one order: a dot below comes before an acute accent.
    expect(storedAs('q\u0301\u0323')).toBe('q\u0323\u0301');
  });

  it('collapses whitespace to single spaces and trims it', () => {
    expect(storedAs('  New \t York\n')).toBe('New York');
    expect(storedAs('New\r\nYork')).toBe('New York');
    // A no-break space and an ideographic space are whitespace too.
    expect(storedAs('New\u00A0York')).toBe('New York');
    expect(storedAs('\u3000New\u3000\u3000York\u3000')).toBe('New York');
  });

  it('takes `/` and the other characters of the search syntax for ordinary ones', () => {
    const names = [
      'Trips/2024/Japan',
      '/',
      'a:b',
      'tag:France',
      '-draft',
      '- draft',
      'Paris (Texas)',
      'a=b',
      'France=',
      "l'\u00E9t\u00E9",
      '\u201Ccheese\u201D',
      'back\\slash',
      '100%',
      '\u6771\u4EAC',
      FAMILY,
      `picnic ${FAMILY}`,
    ];
    for (const name of names) {
      expect(normalizeTagName(name), name).toEqual({ ok: true, name });
    }
  });

  it('refuses a name with nothing to see', () => {
    // Whitespace, and characters that take no room: a zero-width space, a joiner, a word joiner, a
    // byte order mark.
    const blank = ['', ' ', ' \t\n ', '\u200B', '\u200D', ' \u2060 ', '\uFEFF'];
    for (const input of blank) {
      expect(problemOf(input), JSON.stringify(input)).toBe('empty');
    }
    // Blanks pasted as spaces (the Hangul fillers, which are letters to Unicode, and the blank
    // Braille pattern), the letters of a flag without their flag, and an interlinear annotation
    // character, drawn as nothing.
    const unseen = ['\u3164', '\u115F\u1160', '\uFFA0', '\u2800', '\u{E0067}\u{E007F}', '\uFFF9'];
    for (const input of unseen) {
      expect(problemOf(input), JSON.stringify(input)).toBe('empty');
    }
    expect(storedAs('a\u200B')).toBe('a\u200B');
  });

  it('stores a character nobody sees as it was typed, all but a byte order mark', () => {
    // Some of them shape the letters around them or join emoji: a name is shown as it was typed.
    const names = ['Paris\u200B', 'Pa\u00ADris', '\u200EParis\u200F', '\u0645\u06CC\u200C\u062E'];
    for (const name of names) {
      expect(storedAs(name), JSON.stringify(name)).toBe(name);
    }
    // A byte order mark is whitespace to JavaScript: left out, it does not cut a word in two.
    expect(storedAs('\uFEFFParis')).toBe('Paris');
    expect(storedAs('Par\uFEFFis')).toBe('Paris');
    expect(storedAs('New\uFEFF York')).toBe('New York');
  });

  it('collapses and trims whitespace through the characters nobody sees, which stay', () => {
    // A direction mark before a space at the start, a zero-width space between two spaces: no
    // space is left that would be seen.
    expect(storedAs('\u200E Paris')).toBe('\u200EParis');
    expect(storedAs('Paris \u200F')).toBe('Paris\u200F');
    expect(storedAs(' \u200B Paris \u200B ')).toBe('\u200BParis\u200B');
    expect(storedAs('New \u200B York')).toBe('New \u200BYork');
    expect(storedAs('New\u200B York')).toBe('New\u200B York');
    // A flag keeps its letters, and the space after it.
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(storedAs([scotland, '2024 '].join(' '))).toBe([scotland, '2024'].join(' '));
  });

  it('refuses a name of combining marks alone, which have no letter to stand on', () => {
    const marks = [
      // An accent, two accents, accents around a space, an accent after a zero-width space.
      '\u0301',
      '\u0301\u0300',
      '\u0301 \u0300',
      '\u200B\u0301',
      // The marks of other scripts and of symbols: a Devanagari vowel sign, an Arabic fatha, an
      // enclosing circle.
      '\u093F',
      '\u064E',
      '\u20DD',
    ];
    for (const input of marks) {
      expect(problemOf(input), JSON.stringify(input)).toBe('empty');
    }
  });

  it('accepts a name that starts with a mark when it holds something to see', () => {
    // A combining solidus before a letter, before a space, and an accent before `=`.
    expect(storedAs('\u0338x')).toBe('\u0338x');
    expect(storedAs('\u0338 x')).toBe('\u0338 x');
    expect(storedAs('\u0301=France')).toBe('\u0301=France');
    // Marks where they belong are part of what is seen: on a heart to show it in colour, on a
    // digit to draw a keycap, on a Devanagari letter to silence its vowel.
    for (const name of ['\u2764\uFE0F', '1\uFE0F\u20E3', '\u0915\u094D']) {
      expect(storedAs(name), JSON.stringify(name)).toBe(name);
    }
  });

  it('refuses a comma, which separates tags', () => {
    expect(problemOf('Paris, France')).toBe('comma');
    expect(problemOf(',')).toBe('comma');
    expect(problemOf('Paris,')).toBe('comma');
  });

  it('refuses a double quote, which a search term cannot hold', () => {
    expect(problemOf('say "cheese"')).toBe('quote');
    expect(problemOf('"')).toBe('quote');
    expect(problemOf('5"')).toBe('quote');
  });

  it('refuses a leading `=`, which means the tag itself in a search', () => {
    expect(problemOf('=France')).toBe('equals');
    expect(problemOf('=')).toBe('equals');
    // Leading once trimmed.
    expect(problemOf('  = France')).toBe('equals');
    // And whatever nobody sees before it: the name is compared without it.
    expect(problemOf('\u200B=France')).toBe('equals');
    expect(problemOf('\u200E =France')).toBe('equals');
    expect(problemOf('a\u200B=France')).toBeNull();
  });

  it('refuses control characters and halves of a character, but not tabs and line breaks', () => {
    const controls = ['a\u0000b', 'a\u0007', '\u001B[0m', 'a\u007F', 'a\u0085b'];
    for (const input of controls) {
      expect(problemOf(input), JSON.stringify(input)).toBe('control');
    }
    // Half of an emoji, as a text cut in the middle of one ends.
    expect(problemOf(FAMILY.slice(0, 1))).toBe('control');
    expect(problemOf(`a${FAMILY.slice(1, 2)}b`)).toBe('control');
    // The overrides that draw the letters after them in another order: `x`, an override and `dcba`
    // read `xabcd`. The marks that only set the direction of a whole name are accepted.
    expect(problemOf('x\u202Edcba')).toBe('control');
    expect(problemOf('x\u202Ddcba')).toBe('control');
    expect(storedAs('\u202BParis\u202C')).toBe('\u202BParis\u202C');
    expect(storedAs('a\tb\nc')).toBe('a b c');
  });

  it('refuses a name longer than 1,024 UTF-16 units, as typed or once composed', () => {
    expect(MAX_TAG_NAME_LENGTH).toBe(1_024);
    expect(storedAs('x'.repeat(1_024))).toBe('x'.repeat(1_024));
    expect(problemOf('x'.repeat(1_025))).toBe('tooLong');
    // A character of two units counts for two.
    expect(problemOf('\u{1F3D6}'.repeat(512))).toBeNull();
    expect(problemOf('\u{1F3D6}'.repeat(513))).toBe('tooLong');
    // A Hebrew letter that NFC writes as three characters: 342 of them as typed, 1,026 as stored.
    expect(storedAs('\uFB2C'.repeat(341))).toHaveLength(1_023);
    expect(problemOf('\uFB2C'.repeat(342))).toBe('tooLong');
  });

  it('refuses a run of more than 30 combining marks', () => {
    expect(MAX_TAG_MARK_RUN).toBe(30);
    expect(problemOf(`q${'\u0316'.repeat(30)}`)).toBeNull();
    expect(problemOf(`q${'\u0316'.repeat(31)}`)).toBe('marks');
    // Whatever marks make the run, and wherever it stands.
    expect(problemOf(`q${'\u0301'.repeat(15)}${'\u0316'.repeat(16)}`)).toBe('marks');
    expect(problemOf('\u0316'.repeat(31))).toBe('marks');
    // Each run counts on its own.
    expect(problemOf(`q${'\u0316'.repeat(30)}q${'\u0316'.repeat(30)}`)).toBeNull();
  });

  it('refuses a run of marks that is too long once composed', () => {
    // NFC writes the Greek dialytika tonos as two marks: 15 of them are stored as a run of 30, and
    // 16 as one of 32.
    expect(storedAs(`q${'\u0344'.repeat(15)}`)).toBe(`q${'\u0308\u0301'.repeat(15)}`);
    expect(problemOf(`q${'\u0344'.repeat(16)}`)).toBe('marks');
    // The same goes for a Tibetan vowel sign.
    expect(storedAs(`\u0F40${'\u0F73'.repeat(15)}`)).toHaveLength(31);
    expect(problemOf(`\u0F40${'\u0F73'.repeat(16)}`)).toBe('marks');
  });

  it('counts a run of marks as the key holds it, without the characters nobody sees', () => {
    const run = '\u0316'.repeat(30);
    const half = '\u0316'.repeat(15);
    // A zero-width space or a soft hyphen parts two runs in the name, not in its key.
    expect(problemOf(`q${run}\u200B${run}`)).toBe('marks');
    expect(problemOf(`q${run}\u00AD${run}`)).toBe('marks');
    expect(problemOf(`q${half}\u200B${half}\u0316`)).toBe('marks');
    // Once composed too: 16 dialytika tonos are stored as 32 marks.
    expect(problemOf(`q${'\u0344'.repeat(8)}\u200B${'\u0344'.repeat(8)}`)).toBe('marks');
    // 30 in all pass, and so do two runs with something seen between them: a space, a flag.
    expect(problemOf(`q${half}\u200B${half}`)).toBeNull();
    expect(problemOf(`q${run} \u200B ${run}`)).toBeNull();
    expect(problemOf(`q${run}\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}${run}`)).toBeNull();
  });

  it('refuses a text past either limit as typed, without composing it', () => {
    // 1,026 units as typed and 513 once composed; 31 marks as typed and 30 once the first is joined
    // to its letter. Composing is what takes long on a long text or a long run of marks.
    const inputs = [
      'e\u0301'.repeat(513),
      `e${'\u0301'.repeat(31)}`,
      // And as compared: two runs of 30 that only a byte order mark parts.
      `q${'\u0316'.repeat(30)}\uFEFF${'\u0316'.repeat(30)}`,
    ];
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const problems = inputs.map(problemOf);
    const composed = normalize.mock.calls.length;
    normalize.mockRestore();

    expect(problems).toEqual(['tooLong', 'marks', 'marks']);
    expect(composed).toBe(0);
  });

  it('accepts again, unchanged, every name it accepts', () => {
    // Every text of up to three of these: characters that NFC joins, splits or moves, the kinds of
    // whitespace, and the characters a name is refused for.
    const letters = [
      'a',
      'E',
      '\u00E9',
      '\u0301',
      '\u0323',
      '\u0338',
      '\u0344',
      '\u0F73',
      '\uFB2C',
      '\u1100',
      '\u1161',
      ' ',
      '\t',
      '\u00A0',
      '\uFEFF',
      '\u200D',
      '\u200B',
      '\u3164',
      '\u{1F3F4}',
      '\u{E0067}',
      '=',
      ',',
      '"',
      '\u0000',
    ];
    const inputs = [''];
    for (let start = 0, length = 1; length <= 3; length++) {
      const end = inputs.length;
      for (let index = start; index < end; index++) {
        for (const letter of letters) {
          inputs.push(`${inputs[index] ?? ''}${letter}`);
        }
      }
      start = end;
    }
    // And names at the limits, as typed or as stored.
    inputs.push(
      'x'.repeat(1_024),
      '\uFB2C'.repeat(341),
      `q${'\u0316'.repeat(30)}`,
      `q${'\u0344'.repeat(15)}`,
      `a${'\u0344'.repeat(15)}`,
      `\u0F40${'\u0F73'.repeat(15)}`,
      ` ${FAMILY}\u00A0\u00A0${FAMILY} `,
    );

    const names = new Set<string>();
    for (const input of inputs) {
      const name = storedAs(input);
      if (name !== null) {
        names.add(name);
      }
    }
    expect(names.size).toBeGreaterThan(1_000);
    for (const name of names) {
      expect(normalizeTagName(name), JSON.stringify(name)).toEqual({ ok: true, name });
      // And each has something to compare: a key and a fold that are not empty, and a key that
      // does not start with the sign of a search for the tag itself.
      expect(tagFold(name), JSON.stringify(name)).not.toBe('');
      expect(tagKey(name).startsWith('='), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('tagNameText', () => {
  it('writes a text as a name is stored: composed, its whitespace collapsed and trimmed', () => {
    expect(tagNameText('E\u0301te\u0301')).toBe('\u00C9t\u00E9');
    expect(tagNameText('  New \t York\n')).toBe('New York');
    expect(tagNameText('\u3000New\u00A0\u00A0York\u3000')).toBe('New York');
    expect(tagNameText(' \t ')).toBe('');
  });

  it('leaves out a byte order mark, and no other character nobody sees', () => {
    expect(tagNameText('\uFEFFParis')).toBe('Paris');
    expect(tagNameText('Par\uFEFFis')).toBe('Paris');
    expect(tagNameText('\uFEFF')).toBe('');
    expect(tagNameText('Paris\u200B')).toBe('Paris\u200B');
  });

  it('checks nothing: a text that cannot be a name is written all the same', () => {
    expect(tagNameText(' =France ')).toBe('=France');
    expect(tagNameText('Paris,  France')).toBe('Paris, France');
    expect(tagNameText('say "cheese"')).toBe('say "cheese"');
    expect(tagNameText(`e${'\u0301'.repeat(40)}`)).toBe(`\u00E9${'\u0301'.repeat(39)}`);
  });

  it('writes a name as `normalizeTagName` stores it', () => {
    const inputs = [
      'E\u0301te\u0301',
      '  New \t York\n',
      'q\u0301\u0323',
      `q${'\u0344'.repeat(15)}`,
      '\uFB2C'.repeat(341),
      ` ${FAMILY}\u00A0\u00A0${FAMILY} `,
    ];
    for (const input of inputs) {
      expect(storedAs(input), JSON.stringify(input)).toBe(tagNameText(input));
    }
  });
});

describe('tagKey', () => {
  it('never tells two names apart by their letter case', () => {
    expect(tagKey('\u00C9t\u00E9')).toBe('\u00E9t\u00E9');
    expect(tagKey('\u00C9T\u00C9')).toBe(tagKey('\u00E9t\u00E9'));
    // Greek and Cyrillic letters have two cases too.
    expect(tagKey('\u0391\u0398\u0389\u039D\u0391')).toBe(tagKey('\u03B1\u03B8\u03AE\u03BD\u03B1'));
    expect(tagKey('\u0401\u041B\u041A\u0410')).toBe(tagKey('\u0451\u043B\u043A\u0430'));
    // In every locale: a Turkish one would make a dotless `i` of `I`.
    expect(tagKey('TITLE')).toBe('title');
  });

  it('writes a Greek sigma the same way wherever it stands in a word', () => {
    // "Road", in capitals, in lower case as Greek is written (a final sigma ends the word), and in
    // lower case with a plain sigma: one tag.
    const plain = '\u03BF\u03B4\u03BF\u03C3';
    expect(tagKey('\u039F\u0394\u039F\u03A3')).toBe(plain);
    expect(tagKey('\u03BF\u03B4\u03BF\u03C2')).toBe(plain);
    expect(tagKey(plain)).toBe(plain);
    // The letter alone: a capital, a final sigma, a sigma.
    expect(tagKey('\u03A3')).toBe('\u03C3');
    expect(tagKey('\u03C2')).toBe('\u03C3');
    // At the end of each word of a name.
    expect(tagKey('\u039F\u0394\u039F\u03A3 \u039F\u0394\u039F\u03A3')).toBe(`${plain} ${plain}`);
  });

  it('takes for two tags the few names that lower-casing each letter leaves apart', () => {
    // Two tags by decision, for simplicity: the key is the name with each letter in lower case,
    // and no table of special cases. The capitals of a sharp s are `SS`, whose lower case is `ss`.
    expect(tagKey('Stra\u00DFe')).toBe('stra\u00DFe');
    expect(tagKey('STRASSE')).toBe('strasse');
    // The lower case of the dotted capital I of Turkish is an `i` with a combining dot above,
    // which is not the `i` of `istanbul` and `ISTANBUL`.
    expect(tagKey('\u0130stanbul')).toBe('i\u0307stanbul');
    expect(tagKey('ISTANBUL')).toBe('istanbul');
  });

  it('tells two names apart by their accents', () => {
    expect(tagKey('c\u00F4te')).not.toBe(tagKey('c\u00F4t\u00E9'));
    expect(tagKey('Egypte')).not.toBe(tagKey('\u00C9gypte'));
    expect(tagKey('\u03B1\u03B8\u03B7\u03BD\u03B1')).not.toBe(
      tagKey('\u03B1\u03B8\u03AE\u03BD\u03B1'),
    );
  });

  it('never tells two names apart by a character nobody sees', () => {
    // As a paste from a web page carries them: a zero-width space, a soft hyphen, a word joiner,
    // direction marks around the name.
    const pasted = [
      'Paris\u200B',
      'Pa\u00ADris',
      'Par\u2060is',
      '\u200EParis\u200F',
      '\u202BParis\u202C',
      '\u2066PARIS\u2069',
    ];
    for (const name of pasted) {
      expect(tagKey(name), JSON.stringify(name)).toBe('paris');
    }
    // A letter and its accent are one letter again once what stood between them is left out.
    expect(tagKey('e\u200B\u0301t\u00E9')).toBe('\u00E9t\u00E9');
    // A Persian word, with and without the zero-width non-joiner that shapes its letters.
    expect(tagKey('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645')).toBe(
      '\u0645\u06CC\u062E\u0648\u0627\u0647\u0645',
    );
    // A heart in colour and the heart as text; a family and its members side by side.
    expect(tagKey('\u2764\uFE0F')).toBe('\u2764');
    expect(tagKey(FAMILY)).toBe('\u{1F468}\u{1F469}\u{1F467}');
    // Interlinear annotation characters, drawn as nothing though Unicode does not say so.
    expect(tagKey('Par\uFFF9is\uFFFB')).toBe('paris');
  });

  it('takes a blank pasted as a space for a space', () => {
    // The Hangul fillers and the blank Braille pattern, which social networks use as spaces.
    for (const blank of ['\u3164', '\uFFA0', '\u115F', '\u1160', '\u2800', '\u3164\u200B\u2800']) {
      expect(tagKey(`New${blank}York`), JSON.stringify(blank)).toBe('new york');
    }
    expect(tagKey('\u3164Paris\u2800')).toBe('paris');
  });

  it('does not count a space for having a character nobody sees beside it', () => {
    expect(tagKey('\u200E Paris')).toBe('paris');
    expect(tagKey('Paris \u200B')).toBe('paris');
    expect(tagKey('New \u200B York')).toBe('new york');
    expect(tagKey('New\u200B York')).toBe('new york');
  });

  it('keeps the letters of a flag, which are all that tells it from another', () => {
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(tagKey(england)).toBe(england);
    expect(tagKey(scotland)).toBe(scotland);
    expect(tagKey(england)).not.toBe(tagKey('\u{1F3F4}'));
    expect(tagKey(['Trip', scotland, '2024'].join(' '))).toBe(['trip', scotland, '2024'].join(' '));
    // Anywhere else, nobody sees them.
    expect(tagKey('a\u{E0067}\u{E0062}')).toBe('a');
    expect(tagKey('\u{1F3F4}\u200B\u{E0067}\u{E007F}')).toBe('\u{1F3F4}');
  });

  it('takes a flag that is not spelled as Unicode spells one for the black flag it is drawn as', () => {
    const blackFlag = '\u{1F3F4}';
    // Without its cancel tag, with a capital letter, with a tag space, with its cancel tag alone.
    const misspelled = [
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}',
      '\u{1F3F4}\u{E0047}\u{E0042}\u{E0045}\u{E004E}\u{E0047}\u{E007F}',
      '\u{1F3F4}\u{E0020}\u{E007F}',
      '\u{1F3F4}\u{E007F}',
    ];
    for (const flag of misspelled) {
      expect(tagKey(flag), JSON.stringify(flag)).toBe(blackFlag);
    }
  });

  it('is the key of its own result', () => {
    const names = [
      '\u00C9t\u00E9',
      'Paris\u200B',
      '\u200E Paris',
      'New \u200B York',
      'e\u200B\u0301',
      '\u039F\u0394\u039F\u03A3',
      FAMILY,
    ];
    for (const name of names) {
      expect(tagKey(tagKey(name)), JSON.stringify(name)).toBe(tagKey(name));
    }
  });

  it('tells apart names that differ by anything else', () => {
    expect(tagKey('Trips/Japan')).not.toBe(tagKey('Trips Japan'));
    expect(tagKey('Paris')).not.toBe(tagKey('Paris (Texas)'));
  });
});

describe('tagFold', () => {
  it('drops letter case and the accents of Latin letters', () => {
    expect(tagFold('\u00C9t\u00E9')).toBe('ete');
    expect(tagFold('No\u00EBl')).toBe('noel');
    expect(tagFold('\u00C5ngstr\u00F6m')).toBe('angstrom');
    expect(tagFold('Fran\u00E7ois, Jos\u00E9 y Pe\u00F1a')).toBe('francois, jose y pena');
    // Two accents on one letter, as Vietnamese writes them.
    expect(tagFold('Vi\u1EC7t Nam')).toBe('viet nam');
    expect(tagFold('c\u00F4te')).toBe(tagFold('c\u00F4t\u00E9'));
  });

  it('drops the accents of Greek and Cyrillic letters', () => {
    expect(tagFold('\u0391\u03B8\u03AE\u03BD\u03B1')).toBe('\u03B1\u03B8\u03B7\u03BD\u03B1');
    expect(tagFold('\u0401\u043B\u043A\u0430')).toBe('\u0435\u043B\u043A\u0430');
  });

  it('leaves the marks of other scripts, which are part of their letters', () => {
    // Japanese: `ga` is `ka` with a voicing mark, and another syllable.
    expect(tagFold('\u304C\u304F')).toBe('\u304C\u304F');
    expect(tagFold('\u304C\u304F')).not.toBe(tagFold('\u304B\u304F'));
    // Hindi, with its vowel signs; Hebrew, with its points; Korean, which NFD takes apart.
    const untouched = [
      '\u0939\u093F\u0902\u0926\u0940',
      '\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD',
      '\uD55C\uAE00',
      '\u0E44\u0E17\u0E22',
    ];
    for (const name of untouched) {
      expect(tagFold(name), name).toBe(name);
    }
  });

  it('folds the first letters of a name to the start of its fold, wherever they stop', () => {
    // "Kosmos" in capitals. JavaScript lower-cases a capital sigma in two ways, inside a word and
    // at its end, and a text typed letter by letter ends on each letter in turn.
    const capitals = '\u039A\u039F\u03A3\u039C\u039F\u03A3';
    const fold = '\u03BA\u03BF\u03C3\u03BC\u03BF\u03C3';
    expect(tagFold(capitals)).toBe(fold);
    for (let length = 1; length <= capitals.length; length++) {
      expect(tagFold(capitals.slice(0, length)), `${length} letters`).toBe(fold.slice(0, length));
    }
    // In lower case, with its accent and its final sigma.
    expect(tagFold('\u03BA\u03CC\u03C3\u03BC\u03BF\u03C2')).toBe(fold);
  });

  it('leaves out the characters nobody sees, as the key does', () => {
    expect(tagFold('\u00C9\u200Bt\u00E9')).toBe('ete');
    expect(tagFold('Pa\u00ADris')).toBe('paris');
    expect(tagFold('\u200B')).toBe('');
  });

  it('collapses and trims the spaces that an accent on a space leaves', () => {
    expect(tagFold('a \u0301 b')).toBe('a b');
    expect(tagFold('\u0338 x')).toBe('x');
    expect(tagFold('a \u0301')).toBe('a');
  });

  it('is the same for a name and for its key', () => {
    for (const name of [
      '\u00C9t\u00E9',
      'New York',
      '\u0391\u03B8\u03AE\u03BD\u03B1',
      'a\u200Bb',
    ]) {
      expect(tagFold(tagKey(name)), name).toBe(tagFold(name));
    }
  });
});

describe('tagTerm', () => {
  it('writes the term that finds a tag and the tags below it', () => {
    expect(tagTerm('France')).toBe('tag:France');
    expect(tagTerm('Trips/2024/Japan')).toBe('tag:Trips/2024/Japan');
    expect(tagTerm('-draft')).toBe('tag:-draft');
    expect(tagTerm('a:b')).toBe('tag:a:b');
  });

  it('writes with `=` the term that finds the tag itself', () => {
    expect(tagTerm('France', true)).toBe('tag:=France');
    expect(tagTerm('France', false)).toBe('tag:France');
  });

  it('quotes a name that holds a space, with its `=` inside the quotes', () => {
    expect(tagTerm('New York')).toBe('tag:"New York"');
    expect(tagTerm('New York', true)).toBe('tag:"=New York"');
    expect(tagTerm('Paris (Texas)')).toBe('tag:"Paris (Texas)"');
  });
});

describe('describeTagNameProblem', () => {
  it('has a sentence of its own for each reason a name is refused', () => {
    const problems: Record<TagNameProblem, string> = {
      empty: '',
      comma: 'Paris, France',
      quote: 'say "cheese"',
      equals: '=France',
      control: 'a\u0007',
      tooLong: 'x'.repeat(1_025),
      marks: `q${'\u0316'.repeat(31)}`,
    };
    const sentences = Object.entries(problems).map(([problem, input]) => {
      expect(problemOf(input), problem).toBe(problem);
      return describeTagNameProblem(problem as TagNameProblem);
    });
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^A tag .+\.$/);
    }
    expect(describeTagNameProblem('tooLong')).toBe('A tag cannot be longer than 1,024 characters.');
  });
});
