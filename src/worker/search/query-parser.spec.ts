import { normalizeTagName, tagTerm } from '@shared/tag-names';
import { describe, expect, it, vi } from 'vitest';
import { parseQuery, parseSize, parseSizeRange } from './query-parser';

describe('parseQuery', () => {
  it('splits free text, keeping quoted phrases together', () => {
    expect(parseQuery('beach  "summer trip"')).toEqual([
      { type: 'text', value: 'beach', negated: false },
      { type: 'text', value: 'summer trip', negated: false },
    ]);
  });

  it('parses operators, aliases, lists and negation', () => {
    expect(
      parseQuery('tag:Japan,"New York" -tag:draft type:video ext:.JPG,png is:untagged'),
    ).toEqual([
      {
        type: 'tag',
        names: [
          { name: 'Japan', exact: false },
          { name: 'New York', exact: false },
        ],
        negated: false,
      },
      { type: 'tag', names: [{ name: 'draft', exact: false }], negated: true },
      { type: 'kind', kind: 'video', negated: false },
      { type: 'ext', exts: ['jpg', 'png'], negated: false },
      { type: 'state', state: 'untagged', negated: false },
    ]);
  });

  it('reads `=` before a tag name as the tag itself, for that name of a list only', () => {
    expect(parseQuery('tag:=France -tag:=France')).toEqual([
      { type: 'tag', names: [{ name: 'France', exact: true }], negated: false },
      { type: 'tag', names: [{ name: 'France', exact: true }], negated: true },
    ]);
    expect(parseQuery('tag:=France,Paris,=Rome')).toEqual([
      {
        type: 'tag',
        names: [
          { name: 'France', exact: true },
          { name: 'Paris', exact: false },
          { name: 'Rome', exact: true },
        ],
        negated: false,
      },
    ]);
    // Inside the quotes, as the chip of a tag writes it, or before them.
    expect(parseQuery('tag:"=New York" tag:="New York"')).toEqual([
      { type: 'tag', names: [{ name: 'New York', exact: true }], negated: false },
      { type: 'tag', names: [{ name: 'New York', exact: true }], negated: false },
    ]);
    // Only the first `=` is the operator: the rest is looked for as it is written, `=` included.
    expect(parseQuery('tag:==France')).toEqual([
      { type: 'tag', names: [{ name: '=France', exact: true }], negated: false },
    ]);
  });

  it('takes the name of a tag as it is typed: `/`, `:`, `-` and brackets are ordinary', () => {
    const named = (name: string) => [
      { type: 'tag', names: [{ name, exact: false }], negated: false },
    ];
    expect(parseQuery('tag:/Trips/2024/Japan/')).toEqual(named('/Trips/2024/Japan/'));
    expect(parseQuery('tag:/')).toEqual(named('/'));
    expect(parseQuery('tag:a:b')).toEqual(named('a:b'));
    expect(parseQuery('tag:tag:France')).toEqual(named('tag:France'));
    expect(parseQuery('tag:-draft')).toEqual(named('-draft'));
    expect(parseQuery('tag:"Paris (Texas)"')).toEqual(named('Paris (Texas)'));
    expect(parseQuery('-tag:-draft')).toEqual([
      { type: 'tag', names: [{ name: '-draft', exact: false }], negated: true },
    ]);
  });

  it('collapses the whitespace of a quoted tag name and trims it, as names are stored', () => {
    expect(parseQuery('tag:"  New \t  York ","= Rio  de Janeiro"')).toEqual([
      {
        type: 'tag',
        names: [
          { name: 'New York', exact: false },
          { name: 'Rio de Janeiro', exact: true },
        ],
        negated: false,
      },
    ]);
  });

  it('writes a tag name composed however it is typed, reading its `=` first', () => {
    expect(parseQuery('tag:E\u0301te\u0301,=E\u0301te\u0301')).toEqual([
      {
        type: 'tag',
        names: [
          { name: 'Été', exact: false },
          { name: 'Été', exact: true },
        ],
        negated: false,
      },
    ]);
    // A name may start with a combining solidus, which NFC would join to the `=` before it.
    expect(parseQuery('tag:=\u0338x')).toEqual([
      { type: 'tag', names: [{ name: '\u0338x', exact: true }], negated: false },
    ]);
    expect(parseQuery('tag:≠x')).toEqual([
      { type: 'tag', names: [{ name: '≠x', exact: false }], negated: false },
    ]);
  });

  it('writes every other value composed however it is typed', () => {
    expect(parseQuery('E\u0301te\u0301 "e\u0301te\u0301 a\u0300" in:E\u0301te\u0301')).toEqual([
      { type: 'text', value: 'Été', negated: false },
      { type: 'text', value: 'été à', negated: false },
      { type: 'folder', value: 'Été', negated: false },
    ]);
    expect(parseQuery('cle\u0301:e\u0301te\u0301')).toEqual([
      { type: 'text', value: 'clé:été', negated: false },
    ]);
  });

  it('composes a term once, whatever its kind, and each name of a tag term once', () => {
    // Composing takes long on a pasted run of combining marks: no term pays for it twice.
    const composed = (query: string): number => {
      const normalize = vi.spyOn(String.prototype, 'normalize');
      parseQuery(query);
      const calls = normalize.mock.calls.length;
      normalize.mockRestore();
      return calls;
    };
    for (const term of ['beach', '"summer trip"', '-beach', 'in:2024', 'tag:France', 'foo:bar']) {
      expect(composed(term), term).toBe(1);
    }
    expect(composed('tag:=France,Paris')).toBe(2);
    expect(composed('beach in:2024 tag:France,Paris foo:bar')).toBe(5);
  });

  it('reads back the name of a tag from the search term written for it', () => {
    const names = [
      'France',
      'New York',
      'Trips/2024/Japan',
      '/',
      ':',
      'a:b',
      'tag:France',
      'is:untagged',
      '-',
      '-draft',
      '- draft',
      'Paris (Texas)',
      'a=b',
      '≠',
      '\u0338x',
      '\u0338 x',
      'x\u0338',
      "l'été",
      '100%',
      'a_b',
      'back\\slash',
      '東京',
      '👍🏽',
      // Emoji made of several, held together by zero-width joiners.
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      '\u{1F3F3}\uFE0F\u200D\u{1F308}',
      'picnic \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
    ];

    for (const name of names) {
      expect(normalizeTagName(name), name).toEqual({ ok: true, name });
      expect(parseQuery(tagTerm(name)), tagTerm(name)).toEqual([
        { type: 'tag', names: [{ name, exact: false }], negated: false },
      ]);
      expect(parseQuery(tagTerm(name, true)), tagTerm(name, true)).toEqual([
        { type: 'tag', names: [{ name, exact: true }], negated: false },
      ]);
      expect(parseQuery(`-${tagTerm(name)}`), `-${tagTerm(name)}`).toEqual([
        { type: 'tag', names: [{ name, exact: false }], negated: true },
      ]);
    }
  });

  it('parses states, including duplicates', () => {
    expect(parseQuery('is:duplicate -is:duplicates is:missing')).toEqual([
      { type: 'state', state: 'duplicate', negated: false },
      { type: 'state', state: 'duplicate', negated: true },
      { type: 'state', state: 'missing', negated: false },
    ]);
  });

  it('ignores incomplete terms typed so far', () => {
    expect(parseQuery('tag: size:> is:')).toEqual([]);
    expect(parseQuery('tag:= tag:=, tag:"= " -tag:=')).toEqual([]);
    expect(parseQuery('tag:France,= tag:=,,Paris')).toEqual([
      { type: 'tag', names: [{ name: 'France', exact: false }], negated: false },
      { type: 'tag', names: [{ name: 'Paris', exact: false }], negated: false },
    ]);
    expect(parseQuery('-')).toEqual([{ type: 'text', value: '-', negated: false }]);
  });

  it('treats unknown keys and quoted colons as text', () => {
    expect(parseQuery('foo:bar "a:b"')).toEqual([
      { type: 'text', value: 'foo:bar', negated: false },
      { type: 'text', value: 'a:b', negated: false },
    ]);
  });

  it('treats as text the keys that every object has, as any unknown key', () => {
    expect(parseQuery('constructor:abc -__proto__:abc')).toEqual([
      { type: 'text', value: 'constructor:abc', negated: false },
      { type: 'text', value: '__proto__:abc', negated: true },
    ]);
    // Composed, like any text.
    expect(parseQuery('constructor:e\u0301te\u0301 __proto__:"a\u0300 b"')).toEqual([
      { type: 'text', value: 'constructor:été', negated: false },
      { type: 'text', value: '__proto__:"à b"', negated: false },
    ]);
  });

  it('normalises folder separators', () => {
    expect(parseQuery('in:2024\\japan')).toEqual([
      { type: 'folder', value: '2024/japan', negated: false },
    ]);
  });

  it('leaves a byte order mark out of the query, as it is left out of a name', () => {
    const paris = { type: 'tag', names: [{ name: 'Paris', exact: false }], negated: false };
    expect(parseQuery('tag:Pa\uFEFFris')).toEqual([paris]);
    expect(parseQuery('tag:\uFEFFParis')).toEqual([paris]);
    expect(parseQuery('\uFEFFtag:Paris\uFEFF')).toEqual([paris]);
    expect(parseQuery('-tag:\uFEFFParis')).toEqual([{ ...paris, negated: true }]);
    expect(parseQuery('tag:=\uFEFFParis')).toEqual([
      { type: 'tag', names: [{ name: 'Paris', exact: true }], negated: false },
    ]);
    expect(parseQuery('Pa\uFEFFris')).toEqual([{ type: 'text', value: 'Paris', negated: false }]);
    expect(parseQuery('tag:\uFEFF')).toEqual([]);
  });

  it('reads the `=` of a tag name through the characters nobody sees before it', () => {
    expect(parseQuery('tag:\u200B=Bordeaux,"\u200E =Lyon"')).toEqual([
      {
        type: 'tag',
        names: [
          { name: 'Bordeaux', exact: true },
          { name: 'Lyon', exact: true },
        ],
        negated: false,
      },
    ]);
    // Not after something seen.
    expect(parseQuery('tag:a\u200B=b')).toEqual([
      { type: 'tag', names: [{ name: 'a\u200B=b', exact: false }], negated: false },
    ]);
  });
});

describe('sizes', () => {
  it('uses decimal units', () => {
    expect(parseSize('1.5mb')).toBe(1_500_000);
    expect(parseSize('2 GB')).toBe(2_000_000_000);
    expect(parseSize('12')).toBe(12);
    expect(parseSize('12 apples')).toBeNull();
  });

  it('parses comparisons and ranges', () => {
    expect(parseSizeRange('>10mb')).toEqual({ min: 10_000_001, max: null });
    expect(parseSizeRange('<=1kb')).toEqual({ min: null, max: 1_000 });
    expect(parseSizeRange('1mb..2mb')).toEqual({ min: 1_000_000, max: 2_000_000 });
    expect(parseSizeRange('5mb')).toEqual({ min: 5_000_000, max: null });
    expect(parseSizeRange('>')).toBeNull();
  });
});
