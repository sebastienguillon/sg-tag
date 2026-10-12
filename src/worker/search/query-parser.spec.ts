import { describe, expect, it } from 'vitest';
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
      parseQuery('tag:trips/japan,"family/kids" -tag:draft type:video ext:.JPG,png is:untagged'),
    ).toEqual([
      { type: 'tag', paths: ['trips/japan', 'family/kids'], negated: false },
      { type: 'tag', paths: ['draft'], negated: true },
      { type: 'kind', kind: 'video', negated: false },
      { type: 'ext', exts: ['jpg', 'png'], negated: false },
      { type: 'state', state: 'untagged', negated: false },
    ]);
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
    expect(parseQuery('-')).toEqual([{ type: 'text', value: '-', negated: false }]);
  });

  it('treats unknown keys and quoted colons as text', () => {
    expect(parseQuery('foo:bar "a:b"')).toEqual([
      { type: 'text', value: 'foo:bar', negated: false },
      { type: 'text', value: 'a:b', negated: false },
    ]);
  });

  it('normalises folder separators', () => {
    expect(parseQuery('in:2024\\japan')).toEqual([
      { type: 'folder', value: '2024/japan', negated: false },
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
