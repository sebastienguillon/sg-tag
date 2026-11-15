import type { SortOrder } from '@shared/model';
import { normalizeTagName, tagFold, tagKey, tagTerm } from '@shared/tag-names';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { SearchService } from './search-service';

const NEWEST: SortOrder = { field: 'modified', direction: 'desc' };

/** A repeatable source of numbers from 0 up to 1 (mulberry32): a failure can be run again. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('SearchService', () => {
  let library: TestLibrary;
  let service: SearchService;
  let offline: number[];
  const ids: Record<string, number> = {};

  const search = (query: string, sort: SortOrder = NEWEST): number[] =>
    Array.from(service.search({ query, sort }).ids);

  beforeEach(() => {
    library = createTestLibrary();
    offline = [];
    service = new SearchService(library.db, () => offline);
    ids['beach'] = library.addFile('2024/Été à Kyōto/beach.jpg', { size: 5_000_000 });
    ids['sunset'] = library.addFile('2024/Été à Kyōto/sunset.HEIC', { size: 2_000_000 });
    ids['clip'] = library.addFile('videos/clip.mp4', { size: 50_000_000 });
    ids['scan'] = library.addFile('scan_01.jpeg', { size: 300_000 });
    library.addTag('Japan', { parents: ['Trips'] });
    library.addTag('Kids', { parents: ['Family'] });
    library.tags.addToFiles([ids['beach'] ?? 0], ['Japan']);
    library.tags.addToFiles([ids['clip'] ?? 0], ['Kids', 'draft']);
  });

  it('lists everything newest first for an empty query', () => {
    expect(search('')).toEqual([ids['scan'], ids['clip'], ids['sunset'], ids['beach']]);
  });

  it('matches substrings of names and folders, ignoring case and diacritics', () => {
    expect(search('kyoto')).toEqual([ids['sunset'], ids['beach']]);
    expect(search('"ETE A"')).toEqual([ids['sunset'], ids['beach']]);
    expect(search('unse')).toEqual([ids['sunset']]);
  });

  it('handles terms shorter than a trigram and LIKE wildcards literally', () => {
    expect(search('cl')).toEqual([ids['clip']]);
    expect(search('n_0')).toEqual([ids['scan']]);
    expect(search('%')).toEqual([]);
  });

  it('matches free text against tag names too', () => {
    expect(search('japan')).toEqual([ids['beach']]);
  });

  it('ignores the characters nobody sees in free text, for names and folders as for tags', () => {
    // As a paste from a web page brings them: a zero-width space, a soft hyphen, a direction mark.
    const inKyoto = [ids['sunset'], ids['beach']];
    expect(search('kyoto\u200B')).toEqual(inKyoto);
    expect(search('ky\u00ADoto')).toEqual(inKyoto);
    expect(search('\u200Ekyoto')).toEqual(inKyoto);
    expect(search('-kyoto\u200B')).toEqual([ids['scan'], ids['clip']]);
    // The name of a file and the name of a tag alike.
    expect(search('be\u200Bach')).toEqual([ids['beach']]);
    expect(search('jap\u200Ban')).toEqual([ids['beach']]);
    // Under 3 characters once they are left out, where names and folders are searched another way.
    expect(search('cl\u200B')).toEqual([ids['clip']]);
    expect(search('c\u00ADl')).toEqual([ids['clip']]);
    expect(search('-cl\u200B')).toEqual([ids['scan'], ids['sunset'], ids['beach']]);
  });

  it('finds by the text as typed a file whose name holds a character nobody sees', () => {
    // Two emoji that a zero-width joiner makes one, and three: under 3 characters without the
    // joiners, and from 3.
    const redhead = '\u{1F469}\u200D\u{1F9B0}';
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const named = [library.addFile(`${redhead}.jpg`), library.addFile(`${family}.jpg`)];

    expect(search(redhead)).toEqual([named[0]]);
    expect(search(family)).toEqual([named[1]]);
  });

  it('matches tags by their whole name, with the tags below them', () => {
    expect(search('tag:trips')).toEqual([ids['beach']]);
    expect(search('tag:japan')).toEqual([ids['beach']]);
    expect(search('tag:jap')).toEqual([]);
    expect(search('tag:FAMILY')).toEqual([ids['clip']]);
    expect(search('tag:draft,trips')).toEqual([ids['clip'], ids['beach']]);
  });

  it('combines terms with AND and supports negation', () => {
    expect(search('kyoto -tag:trips')).toEqual([ids['sunset']]);
    expect(search('-type:image')).toEqual([ids['clip']]);
    expect(search('is:untagged')).toEqual([ids['scan'], ids['sunset']]);
    expect(search('is:tagged type:video')).toEqual([ids['clip']]);
  });

  it('expands extension aliases and compares sizes', () => {
    expect(search('ext:jpg')).toEqual([ids['scan'], ids['beach']]);
    expect(search('ext:heic')).toEqual([ids['sunset']]);
    expect(search('size:>4mb')).toEqual([ids['clip'], ids['beach']]);
    expect(search('size:1mb..10mb')).toEqual([ids['sunset'], ids['beach']]);
  });

  it('hides missing files unless asked for them', () => {
    library.files.markMissing(ids['beach'] ?? 0, Date.now());
    // Untagged: only kept a while, in case it moved.
    library.files.markMissing(ids['scan'] ?? 0, Date.now());
    expect(search('kyoto')).toEqual([ids['sunset']]);
    expect(search('is:missing')).toEqual([ids['beach']]);
  });

  it('lists files that have an identical copy, copies side by side, largest first', () => {
    const beachCopy = library.addFile('backup/beach.jpg', { size: 5_000_000 });
    const clipCopy = library.addFile('backup/clip.mp4', { size: 50_000_000 });
    const hash = library.db.prepare<[string, number]>(
      'UPDATE files SET content_hash = ? WHERE id = ?',
    );
    hash.run('beach', ids['beach'] ?? 0);
    hash.run('beach', beachCopy);
    hash.run('clip', ids['clip'] ?? 0);
    hash.run('clip', clipCopy);
    hash.run('scan', ids['scan'] ?? 0);

    expect(search('is:duplicate')).toEqual([clipCopy, ids['clip'], beachCopy, ids['beach']]);
    expect(search('-is:duplicate')).toEqual([ids['scan'], ids['sunset']]);
    library.files.markMissing(beachCopy, Date.now());
    expect(search('is:duplicate')).toEqual([clipCopy, ids['clip']]);
  });

  it('filters offline roots on request', () => {
    expect(search('is:offline')).toEqual([]);
    offline = library.roots.list().map((root) => root.id);
    expect(search('is:offline')).toHaveLength(4);
  });

  it('sorts by name and size in both directions', () => {
    expect(search('', { field: 'name', direction: 'asc' })).toEqual([
      ids['beach'],
      ids['clip'],
      ids['scan'],
      ids['sunset'],
    ]);
    expect(search('', { field: 'size', direction: 'desc' })).toEqual([
      ids['clip'],
      ids['beach'],
      ids['sunset'],
      ids['scan'],
    ]);
  });
});

/**
 * The tags of these tests, each above the next; Paris has two parents:
 *
 *   Places › Europe › France › Paris › Montmartre
 *   Places › Capitals › Paris
 *   Places › Capitals › Tokyo
 *
 * France is also FR and Hexagone, Paris also Paname. Each tag but Places and Capitals is on one
 * file, called by the name of its tag in lower case; one file has no tag.
 */
describe('SearchService, searching tags', () => {
  let library: TestLibrary;
  let service: SearchService;
  /** The id of each file by what the expectations call it. */
  let files: Map<string, number>;

  /**
   * Adds a file that carries `tags`, called `label` in the expectations. Its name on disk is a
   * number, so that no free text finds it by its name.
   */
  const addTagged = (label: string, tags: readonly string[]): void => {
    const id = library.addFile(`${files.size + 1}.jpg`);
    const outcomes = library.tags.addToFiles([id], tags);
    expect(
      outcomes.map((outcome) => outcome.status),
      label,
    ).toEqual(tags.map(() => 'added'));
    files.set(label, id);
  };

  /** What the files found by a query are called, in alphabetical order: each as often as found. */
  const found = (query: string): string[] => {
    const labels = new Map(Array.from(files, ([label, id]) => [id, label]));
    return Array.from(
      service.search({ query, sort: NEWEST }).ids,
      (id) => labels.get(id) ?? `file ${id}`,
    ).sort();
  };

  const tagId = (name: string): number => library.tags.resolve([name])[0]?.id ?? 0;

  beforeEach(() => {
    library = createTestLibrary();
    service = new SearchService(library.db, () => []);
    files = new Map();
    library.addTag('Europe', { parents: ['Places'] });
    library.addTag('Capitals', { parents: ['Places'] });
    library.addTag('France', { aliases: ['FR', 'Hexagone'], parents: ['Europe'] });
    library.addTag('Paris', { aliases: ['Paname'], parents: ['France', 'Capitals'] });
    library.addTag('Montmartre', { parents: ['Paris'] });
    library.addTag('Tokyo', { parents: ['Capitals'] });
    for (const name of ['Europe', 'France', 'Paris', 'Montmartre', 'Tokyo']) {
      addTagged(name.toLowerCase(), [name]);
    }
    addTagged('untagged', []);
  });

  it('finds the files of a tag and of every tag below it, however far below', () => {
    expect(found('tag:Montmartre')).toEqual(['montmartre']);
    expect(found('tag:Paris')).toEqual(['montmartre', 'paris']);
    expect(found('tag:France')).toEqual(['france', 'montmartre', 'paris']);
    expect(found('tag:Europe')).toEqual(['europe', 'france', 'montmartre', 'paris']);
    expect(found('tag:Capitals')).toEqual(['montmartre', 'paris', 'tokyo']);
    expect(found('tag:Places')).toEqual(['europe', 'france', 'montmartre', 'paris', 'tokyo']);
  });

  it('lists a file once, however many ways lead from a tag to it', () => {
    // Paris is below Places through France and through Capitals; this file has three tags that are
    // all below Places.
    addTagged('three tags', ['France', 'Paris', 'Tokyo']);
    const eachOnce = ['europe', 'france', 'montmartre', 'paris', 'three tags', 'tokyo'];

    expect(found('tag:Places')).toEqual(eachOnce);
    expect(found('tag:Places,Europe,Capitals,=Paris')).toEqual(eachOnce);
    expect(found('places')).toEqual(eachOnce);
  });

  it('matches a tag by its whole name, never by a part of it', () => {
    expect(found('tag:Fran')).toEqual([]);
    expect(found('tag:rance')).toEqual([]);
    expect(found('tag:"France Paris"')).toEqual([]);
  });

  it('finds a tag by any of its aliases', () => {
    expect(found('tag:FR')).toEqual(['france', 'montmartre', 'paris']);
    expect(found('tag:hexagone')).toEqual(['france', 'montmartre', 'paris']);
    expect(found('tag:Paname')).toEqual(['montmartre', 'paris']);
    expect(found('tag:paname,tokyo')).toEqual(['montmartre', 'paris', 'tokyo']);
  });

  it('ignores letter case and accents in a tag term', () => {
    library.addTag('Été', { aliases: ['Congés d’août'] });
    addTagged('summer', ['Été']);
    // Two tags that only an accent tells apart: a search does not.
    addTagged('coast', ['côte']);
    addTagged('side', ['côté']);

    expect(found('tag:ete')).toEqual(['summer']);
    expect(found('tag:ÉTÉ')).toEqual(['summer']);
    expect(found('tag:Été')).toEqual(['summer']);
    // Typed with combining accents, as a file name copied on macOS is.
    expect(found('tag:E\u0301te\u0301')).toEqual(['summer']);
    expect(found('tag:=ETE')).toEqual(['summer']);
    expect(found('tag:"conges d’aout"')).toEqual(['summer']);
    expect(found('-tag:ete tag:ÉTÉ,COTE')).toEqual(['coast', 'side']);
    expect(found('tag:cote')).toEqual(['coast', 'side']);
    expect(found('tag:=CÔTÉ')).toEqual(['coast', 'side']);
    expect(found('tag:PLACES')).toEqual(['europe', 'france', 'montmartre', 'paris', 'tokyo']);
  });

  it('ignores the characters nobody sees in a tag term and in the name of a tag', () => {
    // A name pasted from a web page, stored with the soft hyphen it came with.
    addTagged('bordeaux', ['Bor\u00ADdeaux']);

    expect(found('tag:Bordeaux')).toEqual(['bordeaux']);
    expect(found('tag:Bor\u00ADdeaux')).toEqual(['bordeaux']);
    expect(found('tag:=Bordeaux')).toEqual(['bordeaux']);
    expect(found('tag:=bor\u00ADdeaux')).toEqual(['bordeaux']);
    // Typed with others, elsewhere: zero-width spaces, direction marks, a word joiner.
    expect(found('tag:\u200BBORDEAUX\u200B')).toEqual(['bordeaux']);
    expect(found('tag:"\u200EBord\u2060eaux\u200F"')).toEqual(['bordeaux']);
    expect(found('-tag:Bordeaux tag:Bor\u00ADdeaux,Tokyo')).toEqual(['tokyo']);
    // The other way round: a name or an alias stored without any, a term typed with one.
    expect(found('tag:Pa\u00ADris')).toEqual(['montmartre', 'paris']);
    expect(found('tag:=Par\u200Bis')).toEqual(['paris']);
    expect(found('tag:Hexa\u00ADgone')).toEqual(['france', 'montmartre', 'paris']);
    // Nor does a space count for having one beside it: these are no two spaces between the
    // words, and no space before them.
    addTagged('new york', ['New York']);
    expect(found('tag:"New \u200B York"')).toEqual(['new york']);
    expect(found('tag:"=\u200E New York"')).toEqual(['new york']);
  });

  it('finds the files of a tag by the search term written for its name, whatever nobody sees in it', () => {
    // A black flag, then the tag characters that spell `gbeng` and `gbsct`.
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const names = [
      'Bor\u00ADdeaux',
      // Beside a space, which then counts once.
      'New \u200B York',
      '\u200EParis (Texas)\u200F',
      // A Persian word whose letters a zero-width non-joiner shapes.
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645',
      // A heart drawn in colour, and a family: three people held together by zero-width joiners.
      '\u2764\uFE0F',
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      england,
      scotland,
    ];
    // One file for each tag, called by the name of its tag.
    for (const name of names) {
      addTagged(name, [name]);
    }

    for (const name of names) {
      expect(found(tagTerm(name)), tagTerm(name)).toEqual([name]);
      expect(found(tagTerm(name, true)), tagTerm(name, true)).toEqual([name]);
    }
    // The heart as text is the heart in colour; a black flag alone is neither flag.
    expect(found('tag:\u2764')).toEqual(['\u2764\uFE0F']);
    expect(found('tag:\u{1F3F4}')).toEqual([]);
  });

  it('leaves out the files of the tags below a tag that is excluded', () => {
    expect(found('-tag:France')).toEqual(['europe', 'tokyo', 'untagged']);
    expect(found('-tag:Places')).toEqual(['untagged']);
    expect(found('-tag:hexagone,tokyo')).toEqual(['europe', 'untagged']);
    expect(found('tag:Europe -tag:Paris')).toEqual(['europe', 'france']);
  });

  it('finds with `=` the files of the tag itself, not those of the tags below it', () => {
    expect(found('tag:=France')).toEqual(['france']);
    expect(found('tag:=Places')).toEqual([]);
    expect(found('tag:=hexagone')).toEqual(['france']);
    expect(found('tag:=France,=Tokyo')).toEqual(['france', 'tokyo']);
  });

  it('leaves out with `=` the files of the tag itself only', () => {
    expect(found('-tag:=France')).toEqual(['europe', 'montmartre', 'paris', 'tokyo', 'untagged']);
    expect(found('tag:France -tag:=France')).toEqual(['montmartre', 'paris']);
    expect(found('-tag:=France,=Paname')).toEqual(['europe', 'montmartre', 'tokyo', 'untagged']);
  });

  it('finds the files of both kinds of name in one list, with and without `=`', () => {
    expect(found('tag:=Europe,Capitals')).toEqual(['europe', 'montmartre', 'paris', 'tokyo']);
    expect(found('tag:Capitals,=Europe')).toEqual(['europe', 'montmartre', 'paris', 'tokyo']);
    expect(found('tag:=France,France')).toEqual(['france', 'montmartre', 'paris']);
    expect(found('tag:=Places,nothing')).toEqual([]);
    expect(found('-tag:=Europe,Capitals')).toEqual(['france', 'untagged']);
  });

  it('combines several tag terms, each with the tags below its own', () => {
    expect(found('tag:Europe tag:Capitals')).toEqual(['montmartre', 'paris']);
    expect(found('tag:Capitals -tag:Europe')).toEqual(['tokyo']);
    expect(found('tag:Capitals tag:=Paris')).toEqual(['paris']);
    expect(found('tag:Capitals hexagone')).toEqual(['montmartre', 'paris']);
    expect(found('tag:Places is:untagged')).toEqual([]);
    expect(found('tag:Places -is:tagged')).toEqual([]);
  });

  it('takes `/`, a colon, brackets and a leading minus for ordinary characters of a name', () => {
    addTagged('japan', ['Trips/2024/Japan']);
    addTagged('ratio', ['16:9']);
    addTagged('texas', ['Paris (Texas)']);
    addTagged('minus', ['-draft']);

    expect(found('tag:Trips/2024/Japan')).toEqual(['japan']);
    expect(found('tag:=trips/2024/japan')).toEqual(['japan']);
    // No part of the name is a tag of its own, and no `/` is left out of what is typed.
    expect(found('tag:Trips')).toEqual([]);
    expect(found('tag:Japan')).toEqual([]);
    expect(found('tag:2024/Japan')).toEqual([]);
    expect(found('tag:/Trips/2024/Japan/')).toEqual([]);
    expect(found('tag:16:9')).toEqual(['ratio']);
    expect(found('tag:"Paris (Texas)"')).toEqual(['texas']);
    expect(found('tag:Paris')).toEqual(['montmartre', 'paris']);
    expect(found('tag:-draft')).toEqual(['minus']);
    expect(found('-tag:-draft tag:=-draft,16:9')).toEqual(['ratio']);
  });

  it('finds the files of any tag by the search term written for its name', () => {
    const typed = [
      'New York',
      'Trips/2024/Japan',
      '/',
      'a:b',
      'tag:France',
      'is:untagged',
      '-draft',
      '- draft',
      'Paris (Texas)',
      'a=b',
      '≠',
      '\u0338 x',
      'x\u0338',
      "l'été",
      '100%',
      'a_b',
      'back\\slash',
      '東京',
      '👍🏽',
    ];
    // Names made of the characters the search syntax gives a meaning to, and of some it must not.
    const letters = ['a', 'É', 'e', '\u0301', '\u0338', ' ', '/', ':', '-', '=', '≠', '(', '\\'];
    const random = seededRandom(20_261_115);
    // One file for each tag, called by the name of its tag. Names that differ only by letter case
    // are one tag.
    const names = new Map<string, string>();
    while (names.size < 300) {
      const input =
        typed.shift() ??
        Array.from(
          { length: 1 + Math.floor(random() * 6) },
          () => letters[Math.floor(random() * letters.length)],
        ).join('');
      const check = normalizeTagName(input);
      if (check.ok && !names.has(tagKey(check.name))) {
        names.set(tagKey(check.name), check.name);
        addTagged(check.name, [check.name]);
      }
    }

    for (const name of names.values()) {
      // A search does not tell apart the names that differ only by accents.
      const alike = [...names.values()].filter((other) => tagFold(other) === tagFold(name)).sort();
      expect(found(tagTerm(name)), tagTerm(name)).toEqual(alike);
      expect(found(tagTerm(name, true)), tagTerm(name, true)).toEqual(alike);
    }
  });

  it('finds nothing, without failing, for a term that cannot be the name of a tag', () => {
    expect(found('tag:==France')).toEqual([]);
    expect(found('tag:\ud800')).toEqual([]);
    expect(found('tag:France\u0000')).toEqual([]);
    expect(found(`tag:${'France'.repeat(1_000)}`)).toEqual([]);
    expect(found('-tag:\ud800,France\u0000')).toHaveLength(6);
  });

  it('finds through free text the tags whose name contains it, with the tags below them', () => {
    expect(found('capit')).toEqual(['montmartre', 'paris', 'tokyo']);
    expect(found('europe')).toEqual(['europe', 'france', 'montmartre', 'paris']);
    expect(found('PLACES')).toEqual(['europe', 'france', 'montmartre', 'paris', 'tokyo']);
    expect(found('-capit')).toEqual(['europe', 'france', 'untagged']);
    // Under 3 characters, where names and folders are searched another way.
    expect(found('ky')).toEqual(['tokyo']);
    expect(found('eu')).toEqual(['europe', 'france', 'montmartre', 'paris']);
    expect(found('-eu')).toEqual(['tokyo', 'untagged']);
  });

  it('finds through free text the tags one of whose aliases contains it', () => {
    expect(found('exago')).toEqual(['france', 'montmartre', 'paris']);
    expect(found('PANAME')).toEqual(['montmartre', 'paris']);
    expect(found('fr')).toEqual(['france', 'montmartre', 'paris']);
    expect(found('-exago')).toEqual(['europe', 'tokyo', 'untagged']);
  });

  it('ignores letter case and accents when free text is compared with tags', () => {
    library.addTag('Été', { aliases: ['Août'] });
    addTagged('summer', ['Été']);

    expect(found('ete')).toEqual(['summer']);
    expect(found('ÉTÉ')).toEqual(['summer']);
    expect(found('e\u0301te\u0301')).toEqual(['summer']);
    expect(found('aout')).toEqual(['summer']);
    expect(found('ét')).toEqual(['summer']);
    expect(found('OÛ')).toEqual(['summer']);
  });

  it('ignores the characters nobody sees when free text is compared with tags', () => {
    // A name pasted from a web page, stored with the soft hyphen it came with.
    addTagged('bordeaux', ['Bor\u00ADdeaux']);

    expect(found('bordeaux')).toEqual(['bordeaux']);
    expect(found('Bor\u00ADdeaux')).toEqual(['bordeaux']);
    // A part of the name that goes across the soft hyphen, typed without it and with another.
    expect(found('rdea')).toEqual(['bordeaux']);
    expect(found('or\u200Bde')).toEqual(['bordeaux']);
    // Under 3 characters, where names and folders are searched another way.
    expect(found('rd')).toEqual(['bordeaux']);
    expect(found('-bor\u00ADdeaux')).toEqual([
      'europe',
      'france',
      'montmartre',
      'paris',
      'tokyo',
      'untagged',
    ]);
    // The other way round: a name or an alias stored without any, a text typed with one.
    expect(found('mont\u00ADmartre')).toEqual(['montmartre']);
    expect(found('exa\u200Bgo')).toEqual(['france', 'montmartre', 'paris']);
    // Nor does a space count for having one beside it: these are no two spaces between the words.
    addTagged('new york', ['New York']);
    expect(found('"new \u200B york"')).toEqual(['new york']);
  });

  it('finds a tag at every letter of free text typed in Greek capitals', () => {
    // "Kosmos", in capitals and as Greek is written in lower case: with an accent, and a final
    // sigma at the end of the word. Lower-casing must not write the sigma inside the word as a
    // final one when the text typed so far stops on it.
    const capitals = '\u039A\u039F\u03A3\u039C\u039F\u03A3';
    addTagged('capitals', [capitals]);
    addTagged('lower case', ['\u03BA\u03CC\u03C3\u03BC\u03BF\u03C2']);

    for (let length = 1; length <= capitals.length; length++) {
      const typed = capitals.slice(0, length);
      expect(found(typed), `${length} letters`).toEqual(['capitals', 'lower case']);
    }
    // In lower case with a plain sigma at the end, and as a tag term.
    const plain = '\u03BA\u03BF\u03C3\u03BC\u03BF\u03C3';
    expect(found(plain)).toEqual(['capitals', 'lower case']);
    expect(found(`tag:${plain}`)).toEqual(['capitals', 'lower case']);
    expect(found(`tag:=${capitals}`)).toEqual(['capitals', 'lower case']);
  });

  it('collapses the whitespace of free text when it is compared with tags', () => {
    addTagged('new york', ['New York']);
    expect(found('"new  york"')).toEqual(['new york']);
    expect(found('"W\tY"')).toEqual(['new york']);
  });

  it('takes the wildcards of LIKE literally when free text is compared with tags', () => {
    addTagged('percent', ['100%']);
    addTagged('underscore', ['a_b']);
    addTagged('backslash', ['back\\slash']);
    addTagged('letters', ['axb']);

    expect(found('0%')).toEqual(['percent']);
    expect(found('100%')).toEqual(['percent']);
    expect(found('a_b')).toEqual(['underscore']);
    expect(found('_b')).toEqual(['underscore']);
    expect(found('k\\s')).toEqual(['backslash']);
    expect(found('ack\\sl')).toEqual(['backslash']);
  });

  it('does not take a text of accents alone for a part of every name', () => {
    expect(found('\u0301')).toEqual([]);
    expect(found('\u0301\u0300\u0302')).toEqual([]);
    expect(found('-\u0301')).toHaveLength(6);
  });

  it('finds nothing, without failing, for a term of characters nobody sees alone', () => {
    // Left out, they leave nothing to compare: that is no part of every name, and the name of no
    // tag. Names and folders are searched one way under 3 characters and another from 3: a
    // zero-width space, a soft hyphen and a word joiner; then three zero-width spaces, and
    // direction marks around a soft hyphen.
    const unseen = ['\u200B', '\u00AD\u2060', '\u200B\u200B\u200B', '\u200E\u00AD\u200F'];
    for (const text of unseen) {
      const typed = JSON.stringify(text);
      expect(found(text), typed).toEqual([]);
      expect(found(`tag:${text}`), typed).toEqual([]);
      expect(found(`tag:=${text}`), typed).toEqual([]);
      expect(found(`tag:${text},${text}`), typed).toEqual([]);
      expect(found(`-${text}`), typed).toHaveLength(6);
      expect(found(`-tag:${text}`), typed).toHaveLength(6);
    }
    // Quoted with a space between them, and a letter to Unicode that no font draws.
    expect(found('"\u200B \u00AD"')).toEqual([]);
    expect(found('\u3164')).toEqual([]);
    expect(found('tag:\u3164')).toEqual([]);
  });

  it('leaves files missing from disk out of a tag search unless asked for them', () => {
    library.files.markMissing(files.get('paris') ?? 0, Date.now());

    expect(found('tag:France')).toEqual(['france', 'montmartre']);
    expect(found('hexagone')).toEqual(['france', 'montmartre']);
    expect(found('tag:France is:missing')).toEqual(['paris']);
    expect(found('tag:=France is:missing')).toEqual([]);
  });

  it('ends on a loop of parent links, which only a damaged library holds', () => {
    // Places below Montmartre: Places › Europe › France › Paris › Montmartre › Places. With
    // `UNION ALL` in the walk, these searches would never return.
    library.db
      .prepare<[number, number]>('INSERT INTO tag_parents (tag_id, parent_id) VALUES (?, ?)')
      .run(tagId('Places'), tagId('Montmartre'));

    const everyTag = ['europe', 'france', 'montmartre', 'paris', 'tokyo'];
    expect(found('tag:France')).toEqual(everyTag);
    expect(found('tag:Tokyo')).toEqual(['tokyo']);
    expect(found('tag:=France')).toEqual(['france']);
    expect(found('-tag:Montmartre')).toEqual(['untagged']);
    expect(found('hexagone')).toEqual(everyTag);
    expect(found('fr')).toEqual(everyTag);
  });
});
