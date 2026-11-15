import type { TagDeleteResult, TagEditError, TagEditResult } from '@shared/model';
import {
  MAX_TAG_ALIASES,
  MAX_TAG_MARK_RUN,
  MAX_TAG_NAME_LENGTH,
  MAX_TAG_PARENTS,
  normalizeTagName,
  tagFold,
  tagKey,
} from '@shared/tag-names';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../database/database';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary, defineTag, editedTag } from '../testing/test-library';
import { TagsRepository } from './tags-repository';

/** A parent link: the tag, then its parent. */
type Link = readonly [tagId: number, parentId: number];

/**
 * Reads the parent links stored in `db`. Prepared once for the test that reads them thousands of
 * times: preparing the statement takes longer than running it.
 */
function linksReader(db: Db): () => Link[] {
  const links = db.prepare<[], { tagId: number; parentId: number }>(
    'SELECT tag_id AS tagId, parent_id AS parentId FROM tag_parents ORDER BY tag_id, parent_id',
  );
  return () => links.all().map(({ tagId, parentId }) => [tagId, parentId]);
}

function storedLinks(db: Db): Link[] {
  return linksReader(db)();
}

/** Every row that holds a tag, a name, a parent link or the tag of a file. */
function storedRows(db: Db): Record<string, unknown[]> {
  return Object.fromEntries(
    ['tags', 'tag_names', 'tag_parents', 'file_tags'].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
    ]),
  );
}

/** Whether `belowId` is below `aboveId` by `links`, at any depth: worked out by plain search. */
function isBelow(links: readonly Link[], belowId: number, aboveId: number): boolean {
  const seen = new Set<number>();
  const pending = [belowId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const [tagId, parentId] of links) {
      if (tagId === id && !seen.has(parentId)) {
        seen.add(parentId);
        pending.push(parentId);
      }
    }
  }
  return seen.has(aboveId);
}

/**
 * Whether a tag is below itself by `links`. A link to a tag that has no parent is part of no loop:
 * such links are taken away until none is left, or until none can be.
 */
function hasLoop(links: readonly Link[]): boolean {
  const withParent = new Set(links.map(([tagId]) => tagId));
  const left = links.filter(([, parentId]) => withParent.has(parentId));
  return left.length === links.length ? links.length > 0 : hasLoop(left);
}

/**
 * What every method of the repository must leave true: each tag has exactly one name, names are
 * stored as the name rule gives them, a tag made only by tagging files has no alias, no parent and
 * no child tag, no tag has more aliases or parents than a tag may have, and parent links form no
 * loop.
 */
function expectSoundTags(db: Db): void {
  expect(
    db
      .prepare(
        `SELECT t.id FROM tags t
         WHERE (SELECT COUNT(*) FROM tag_names n WHERE n.tag_id = t.id AND n.is_alias = 0) <> 1`,
      )
      .all(),
    'tags without exactly one name',
  ).toEqual([]);
  expect(
    db
      .prepare(
        `SELECT t.id FROM tags t
         WHERE t.kept = 0 AND (
           EXISTS (SELECT 1 FROM tag_names n WHERE n.tag_id = t.id AND n.is_alias = 1)
           OR EXISTS (SELECT 1 FROM tag_parents tp WHERE t.id IN (tp.tag_id, tp.parent_id)))`,
      )
      .all(),
    'tags made only by tagging that have an alias or a parent link',
  ).toEqual([]);
  const names = db.prepare<[], { key: string; fold: string; name: string }>(
    'SELECT key, fold, name FROM tag_names',
  );
  expect(
    names.all().filter(({ key, fold, name }) => {
      const check = normalizeTagName(name);
      return !check.ok || check.name !== name || key !== tagKey(name) || fold !== tagFold(name);
    }),
    'names not stored as the name rule gives them',
  ).toEqual([]);
  expect(
    db
      .prepare<[{ aliases: number; parents: number }]>(
        `SELECT t.id FROM tags t
         WHERE (SELECT COUNT(*) FROM tag_names n WHERE n.tag_id = t.id AND n.is_alias = 1) > @aliases
            OR (SELECT COUNT(*) FROM tag_parents tp WHERE tp.tag_id = t.id) > @parents`,
      )
      .all({ aliases: MAX_TAG_ALIASES, parents: MAX_TAG_PARENTS }),
    'tags with more aliases or parents than a tag may have',
  ).toEqual([]);
  expect(hasLoop(storedLinks(db)), 'a loop of parent links').toBe(false);
}

/**
 * A test library whose tags are checked (`expectSoundTags`) after every call to the repository,
 * those `addTag` makes included.
 */
function createCheckedLibrary(): TestLibrary {
  const library = createTestLibrary();
  const tags = new Proxy(library.tags, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== 'function') {
        return member;
      }
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(member, target, args);
        expectSoundTags(library.db);
        return result;
      };
    },
  });
  return { ...library, tags, addTag: (name, definition) => defineTag(tags, name, definition) };
}

/** Why a change was refused; `null` when it was made. */
function errorOf(result: TagEditResult | TagDeleteResult): TagEditError | null {
  return result.ok ? null : result.error;
}

/** The id of the tag that `name` is the name or an alias of. */
function idOf(tags: TagsRepository, name: string): number {
  const tag = tags.resolve([name])[0];
  if (!tag) {
    throw new Error(`No tag is named ${name}`);
  }
  return tag.id;
}

/**
 * `links` once tag `fromId` has become tag `intoId` at both ends of each: the link there was
 * between the two goes, and links that become the same are one.
 */
function mergedLinks(links: readonly Link[], fromId: number, intoId: number): Link[] {
  const merged = new Map<string, Link>();
  for (const [tagId, parentId] of links) {
    const link: Link = [tagId === fromId ? intoId : tagId, parentId === fromId ? intoId : parentId];
    if (link[0] !== link[1]) {
      merged.set(link.join('>'), link);
    }
  }
  return [...merged.values()];
}

function hasLink(links: readonly Link[], tagId: number, parentId: number): boolean {
  return links.some((link) => link[0] === tagId && link[1] === parentId);
}

/** `links` and the one from `tagId` up to `parentId`, once. */
function withLink(links: readonly Link[], tagId: number, parentId: number): Link[] {
  return hasLink(links, tagId, parentId) ? [...links] : [...links, [tagId, parentId]];
}

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

describe('TagsRepository', () => {
  it('never tells two tags apart by letter case, and keeps the first spelling', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['Été']);

    expect(tags.addToFiles([b], ['été', 'ÉTÉ'])).toMatchObject([
      { name: 'été', status: 'added', tag: { name: 'Été' } },
      { name: 'ÉTÉ', status: 'present', tag: { name: 'Été' } },
    ]);
    expect(tags.list().map(({ name, fileCount }) => [name, fileCount])).toEqual([['Été', 2]]);
    expect(tags.createTag('ÉTÉ')).toMatchObject({ ok: false, error: { kind: 'taken' } });
  });

  it('tells two tags apart by their accents', () => {
    const { tags, addFile } = createCheckedLibrary();
    tags.addToFiles([addFile('a.jpg')], ['côté', 'cote', 'côte']);

    // Names that differ only by accents sort alike: their keys settle the order.
    expect(tags.list().map((tag) => tag.name)).toEqual(['cote', 'côte', 'côté']);
  });

  it('takes a name however its accents are written, and stores it composed', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const decomposed = 'Été'.normalize('NFD');
    tags.addToFiles([a], [decomposed]);

    expect(tags.forFile(a).map((tag) => tag.name)).toEqual(['Été'.normalize('NFC')]);
    expect(tags.addToFiles([a], ['Été'.normalize('NFC')])).toMatchObject([{ status: 'present' }]);
    expect(tags.count()).toBe(1);
  });

  it('never tells two tags apart by a character nobody sees, and keeps the first spelling', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['Paris']);
    const paris = { id: idOf(tags, 'Paris'), name: 'Paris' };

    // As a paste from a web page spells it: with a zero-width space after it, then with a soft
    // hyphen inside it. One file lacked the tag at the first name, none at the second.
    expect(tags.addToFiles([a, b], ['Paris\u200B', 'Pa\u00ADris'])).toEqual([
      { name: 'Paris\u200B', status: 'added', tag: paris },
      { name: 'Pa\u00ADris', status: 'present', tag: paris },
    ]);
    expect(tags.list().map(({ name, fileCount }) => [name, fileCount])).toEqual([['Paris', 2]]);
    expect(errorOf(tags.createTag('Paris\u200B'))).toEqual({
      kind: 'taken',
      owner: paris,
      asAlias: false,
    });
    // Between direction marks, and in capitals around a word joiner.
    expect(tags.resolve(['\u200EParis\u200F', 'PAR\u2060IS'])).toEqual([
      { ...paris, viaAlias: false },
      { ...paris, viaAlias: false },
    ]);
    // Nor does a space count for having one beside it: these are no two spaces between the
    // words, and no space before them.
    tags.addToFiles([a], ['New York']);
    expect(tags.addToFiles([a], ['New \u200B York', '\u200E New York'])).toMatchObject([
      { status: 'present', tag: { name: 'New York' } },
      { status: 'present', tag: { name: 'New York' } },
    ]);
  });

  it('stores a name with the characters nobody sees it was typed with, and compares it without', () => {
    const { db, tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    // A Persian word whose letters a zero-width non-joiner shapes, and the same word without it.
    const shaped = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
    const plain = '\u0645\u06CC\u062E\u0648\u0627\u0647\u0645';
    // A heart drawn in colour, which a variation selector asks for.
    tags.addToFiles([a], ['Pa\u00ADris', shaped, '\u2764\uFE0F']);

    expect(
      db.prepare('SELECT key, fold, name FROM tag_names ORDER BY tag_id').all(),
      'what is stored of each name',
    ).toEqual([
      { key: 'paris', fold: 'paris', name: 'Pa\u00ADris' },
      { key: plain, fold: plain, name: shaped },
      { key: '\u2764', fold: '\u2764', name: '\u2764\uFE0F' },
    ]);
    // The name as it reads is the tag there is, spelled as it was first.
    expect(tags.addToFiles([a], ['Paris', plain, '\u2764'])).toMatchObject([
      { status: 'present', tag: { name: 'Pa\u00ADris' } },
      { status: 'present', tag: { name: shaped } },
      { status: 'present', tag: { name: '\u2764\uFE0F' } },
    ]);
    expect(tags.createTag('PARIS')).toMatchObject({ ok: false, error: { kind: 'taken' } });
    // All but a byte order mark, which JavaScript takes for whitespace: it would cut the name.
    expect(tags.addToFiles([a], ['Ly\uFEFFon'])).toMatchObject([
      { status: 'added', tag: { name: 'Lyon' } },
    ]);
    expect(tags.count()).toBe(4);
  });

  it('takes the flags of England and of Scotland for two tags, which unseen letters tell apart', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    // A black flag, then the tag characters that spell `gbeng` and `gbsct`: nobody sees them, and
    // they are all that makes one flag or the other of it.
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';

    expect(tags.addToFiles([a], [england, scotland]).map((outcome) => outcome.status)).toEqual([
      'added',
      'added',
    ]);
    expect(tags.forFile(a).map((tag) => tag.name)).toEqual([england, scotland]);
    expect(tags.resolve([england, scotland]).map((tag) => tag?.name)).toEqual([england, scotland]);
    // The black flag alone is neither of them.
    expect(tags.resolve(['\u{1F3F4}'])).toEqual([null]);
    expect(tags.count()).toBe(2);
  });

  it('collapses the whitespace of a name and trims it', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['  New \t York \n']);

    expect(tags.forFile(a).map((tag) => tag.name)).toEqual(['New York']);
    expect(tags.resolve(['new   york'])).toMatchObject([{ name: 'New York' }]);
  });

  it('takes `/` for an ordinary character of a name', () => {
    const { tags, addFile } = createCheckedLibrary();
    tags.addToFiles([addFile('a.jpg')], ['Trips/Japan', 'AC/DC']);

    expect(tags.list()).toMatchObject([
      { name: 'AC/DC', parentIds: [] },
      { name: 'Trips/Japan', parentIds: [] },
    ]);
  });

  it('refuses a name that cannot be one, saying why, and changes nothing', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const paris = addTag('Paris');

    for (const [name, problem] of [
      [' \t ', 'empty'],
      ['\u200b', 'empty'],
      ['Paris, France', 'comma'],
      ['say "cheese"', 'quote'],
      ['=France', 'equals'],
      ['bell\u0007', 'control'],
      ['x'.repeat(MAX_TAG_NAME_LENGTH + 1), 'tooLong'],
      [`e${'\u0301'.repeat(MAX_TAG_MARK_RUN + 1)}`, 'marks'],
    ] as const) {
      const invalid = { ok: false, error: { kind: 'invalid', problem } };
      expect(tags.addToFiles([a], [name])).toEqual([{ name, status: 'refused', problem }]);
      expect(tags.createTag(name)).toEqual(invalid);
      expect(tags.renameTag(paris, name, true)).toEqual(invalid);
      expect(tags.addAlias(paris, name)).toEqual(invalid);
      expect(tags.addParent(paris, name)).toEqual(invalid);
      expect(tags.resolve([name])).toEqual([null]);
    }
    expect(tags.list()).toEqual([
      { id: paris, name: 'Paris', aliases: [], parentIds: [], fileCount: 0 },
    ]);
    expect(tags.forFile(a)).toEqual([]);
  });

  it('lists tags by name: numbers by their value, letters whatever their case and accents', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a, b], ['tag 10', 'Tag 9', 'tag 2']);
    tags.addToFiles([a], ['Zoo', 'été', 'Eta', 'beach']);
    const zoo = addTag('Zoo', { aliases: ['Ménagerie', 'animal park', 'Bestiary'] });
    addTag('été', { parents: ['Zoo', 'Seasons', 'année'] });

    expect(tags.list().map(({ name, fileCount }) => [name, fileCount])).toEqual([
      ['année', 0],
      ['beach', 1],
      ['Eta', 1],
      ['été', 1],
      ['Seasons', 0],
      ['tag 2', 2],
      ['Tag 9', 2],
      ['tag 10', 2],
      ['Zoo', 1],
    ]);
    const byName = new Map(tags.list().map((tag) => [tag.name, tag]));
    expect(byName.get('Zoo')?.aliases).toEqual(['animal park', 'Bestiary', 'Ménagerie']);
    expect(byName.get('été')?.parentIds).toEqual([
      byName.get('année')?.id,
      byName.get('Seasons')?.id,
      zoo,
    ]);
    // One tag is read as the list gives it.
    for (const tag of tags.list()) {
      expect(tags.get(tag.id)).toEqual(tag);
    }
    expect(tags.get(999)).toBeNull();
  });

  it('answers for each name given, in order: added, already there, or refused', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['Beach']);
    const beach = { id: idOf(tags, 'Beach'), name: 'Beach' };

    expect(tags.addToFiles([a, b, 999], ['beach', 'a, b', 'Family', 'Beach'])).toEqual([
      { name: 'beach', status: 'added', tag: beach },
      { name: 'a, b', status: 'refused', problem: 'comma' },
      { name: 'Family', status: 'added', tag: { id: idOf(tags, 'Family'), name: 'Family' } },
      { name: 'Beach', status: 'present', tag: beach },
    ]);
    expect(tags.forFile(b).map((tag) => tag.name)).toEqual(['Beach', 'Family']);
  });

  it('makes the tag of an unknown name though none of the files exists, until the next cleanup', () => {
    const { tags } = createCheckedLibrary();

    // No file gained the tag, which is all that `present` says. Taking the tag back is left to the
    // caller, which cleans up when nothing was added.
    expect(tags.addToFiles([999], ['Nowhere'])).toEqual([
      { name: 'Nowhere', status: 'present', tag: { id: idOf(tags, 'Nowhere'), name: 'Nowhere' } },
    ]);
    expect(tags.cleanup()).toBe(1);
    expect(tags.list()).toEqual([]);
  });

  it('tags files with the tag an alias belongs to', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const paris = addTag('Paris', { aliases: ['Paname'] });

    expect(tags.addToFiles([a], ['paname'])).toEqual([
      { name: 'paname', status: 'added', tag: { id: paris, name: 'Paris' } },
    ]);
    expect(tags.forFile(a)).toEqual([{ id: paris, name: 'Paris' }]);
    expect(tags.count()).toBe(1);
  });

  it('resolves names and aliases to their tags, writing nothing', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { aliases: ['Paname'] });

    expect(tags.resolve(['PARIS', ' paname ', 'Lyon', 'a, b'])).toEqual([
      { id: paris, name: 'Paris', viaAlias: false },
      { id: paris, name: 'Paris', viaAlias: true },
      null,
      null,
    ]);
    expect(tags.count()).toBe(1);
  });

  it('attaches tags by their ids, counting each tag once per file that gains it', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    const beach = addTag('Beach');
    const family = addTag('Family');
    tags.attach([a], [beach]);

    // Ids that are not a file or a tag are passed over.
    expect(tags.attach([a, b, 999], [beach, family, 888])).toBe(3);
    expect(tags.attach([a, b], [beach, family])).toBe(0);
    expect(tags.idsForFiles([a, b, 999])).toEqual(
      new Map([
        [a, [beach, family]],
        [b, [beach, family]],
      ]),
    );
  });

  it('lists the tag names of each file, and counts tags and tagged files', () => {
    const { files, tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    const gone = addFile('c.jpg', { missingSince: 1 });
    const untagged = addFile('d.jpg');
    tags.addToFiles([a], ['zoo', 'Beach', 'animals/cat', 'tag 10', 'Tag 9']);
    tags.addToFiles([b, gone], ['beach']);

    expect(tags.namesForFiles([b, a, untagged])).toEqual(
      new Map([
        [a, ['animals/cat', 'Beach', 'Tag 9', 'tag 10', 'zoo']],
        [b, ['Beach']],
      ]),
    );
    expect(tags.count()).toBe(5);
    expect(tags.taggedFileCount()).toBe(3);
    files.delete([gone]);
    expect(tags.taggedFileCount()).toBe(2);
  });

  it('reports usage across a selection', () => {
    const { tags, addFile } = createCheckedLibrary();
    const files = [addFile('a.jpg'), addFile('b.jpg'), addFile('c.jpg')];
    tags.addToFiles(files, ['shared']);
    tags.addToFiles(files.slice(0, 1), ['Solo', 'alone']);

    expect(tags.forSelection(files)).toEqual([
      { id: idOf(tags, 'alone'), name: 'alone', fileCount: 1 },
      { id: idOf(tags, 'shared'), name: 'shared', fileCount: 3 },
      { id: idOf(tags, 'Solo'), name: 'Solo', fileCount: 1 },
    ]);
    expect(tags.forSelection(files.slice(1)).map((tag) => tag.name)).toEqual(['shared']);
  });

  it('copies tags from some files onto others', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['shared', 'from-a']);
    tags.addToFiles([b], ['shared', 'from-b']);

    tags.copyTags([a, b], [a, b]);

    expect(tags.forFile(a).map((tag) => tag.name)).toEqual(['from-a', 'from-b', 'shared']);
    expect(tags.forFile(b).map((tag) => tag.name)).toEqual(['from-a', 'from-b', 'shared']);
  });

  it('lets a tag made by tagging a file go with its last file', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a, b], ['Pariis']);
    const typo = idOf(tags, 'Pariis');

    tags.removeFromFiles([a], [typo]);
    expect(tags.list().map((tag) => tag.name)).toEqual(['Pariis']);
    tags.removeFromFiles([b], [typo]);
    expect(tags.list()).toEqual([]);
  });

  it('keeps the tags made or edited on purpose when an unrelated tag loses its last file', () => {
    const { files, tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const gone = addFile('gone.jpg');
    addTag('Made on purpose');
    tags.addToFiles([a], ['Given an alias', 'Given a parent', 'Renamed', 'typo']);
    addTag('Given an alias', { aliases: ['Other name'] });
    addTag('Given a parent', { parents: ['Parent without a file'] });
    tags.renameTag(idOf(tags, 'Renamed'), 'RENAMED', false);
    tags.addToFiles([gone], ['Only on a deleted file']);

    tags.removeFromFiles(
      [a],
      tags.forFile(a).map((tag) => tag.id),
    );

    expect(tags.list().map((tag) => tag.name)).toEqual([
      'Given a parent',
      'Given an alias',
      'Made on purpose',
      'Only on a deleted file',
      'Parent without a file',
      'RENAMED',
    ]);
    // A file deleted from the library takes its tags with it once the repository is told.
    files.delete([gone]);
    expect(tags.cleanup()).toBe(1);
    expect(tags.cleanup()).toBe(0);
    expect(tags.resolve(['Only on a deleted file'])).toEqual([null]);
    expect(tags.count()).toBe(5);
  });

  it('makes a tag that no file has yet, unless a tag has the name', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { aliases: ['Paname'] });

    const lyon = editedTag(tags.createTag('  Lyon '));
    expect(lyon).toEqual({ id: lyon.id, name: 'Lyon', aliases: [], parentIds: [], fileCount: 0 });
    expect(lyon.id).not.toBe(paris);
    const owner = { id: paris, name: 'Paris' };
    expect(errorOf(tags.createTag('PARIS'))).toEqual({ kind: 'taken', owner, asAlias: false });
    expect(errorOf(tags.createTag('paname'))).toEqual({ kind: 'taken', owner, asAlias: true });
    expect(tags.count()).toBe(2);
  });

  it('renames a tag to its own name in another letter case', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['paris']);
    const paris = idOf(tags, 'paris');

    expect(editedTag(tags.renameTag(paris, 'Paris', true))).toEqual({
      id: paris,
      name: 'Paris',
      aliases: [],
      parentIds: [],
      fileCount: 1,
    });
    // Renamed on purpose: it no longer goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.list().map((tag) => tag.name)).toEqual(['Paris']);
  });

  it('renames a tag to its own name with other characters nobody sees', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    // As pasted from a web page, with a zero-width space after it.
    tags.addToFiles([a], ['Paris\u200B']);
    const paris = idOf(tags, 'Paris');

    // Its own name spelled another way, as in another letter case: only the spelling changes, and
    // there is no other name to keep as an alias.
    expect(editedTag(tags.renameTag(paris, 'Paris', true))).toEqual({
      id: paris,
      name: 'Paris',
      aliases: [],
      parentIds: [],
      fileCount: 1,
    });
    // Renamed on purpose: it no longer goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.list().map((tag) => tag.name)).toEqual(['Paris']);

    // And back to a spelling that holds one.
    expect(editedTag(tags.renameTag(paris, 'Pa\u00ADris', false))).toMatchObject({
      name: 'Pa\u00ADris',
      aliases: [],
    });
    expect(tags.resolve(['Paris'])).toEqual([{ id: paris, name: 'Pa\u00ADris', viaAlias: false }]);
  });

  it('leaves a tag as it is when renamed to the name it has', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Paris']);
    const paris = idOf(tags, 'Paris');

    expect(editedTag(tags.renameTag(paris, ' Paris ', true))).toMatchObject({ name: 'Paris' });
    tags.removeFromFiles([a], [paris]);
    expect(tags.list()).toEqual([]);
  });

  it('swaps the name of a tag with one of its aliases, and back again', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const france = addTag('France', { aliases: ['Hexagone', 'FR'] });
    tags.attach([a], [france]);

    // The alias is spelled as typed; the old name stays as an alias whatever is asked.
    expect(editedTag(tags.renameTag(france, 'hexagone', false))).toEqual({
      id: france,
      name: 'hexagone',
      aliases: ['FR', 'France'],
      parentIds: [],
      fileCount: 1,
    });
    expect(editedTag(tags.renameTag(france, 'France', false))).toMatchObject({
      name: 'France',
      aliases: ['FR', 'hexagone'],
    });
    expect(tags.forFile(a)).toEqual([{ id: france, name: 'France' }]);
  });

  it('renames a tag to the name of a tag merged into it earlier', () => {
    const { tags, addTag } = createCheckedLibrary();
    const deutschland = addTag('Deutschland');
    const germany = addTag('Germany');
    tags.mergeTags(deutschland, germany);

    expect(editedTag(tags.renameTag(germany, 'Deutschland', false))).toMatchObject({
      id: germany,
      name: 'Deutschland',
      aliases: ['Germany'],
    });
  });

  it('refuses to rename a tag to a name another tag has, naming that tag', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { aliases: ['Paname'] });
    const lyon = addTag('Lyon');
    const owner = { id: paris, name: 'Paris' };

    expect(errorOf(tags.renameTag(lyon, 'paris', false))).toEqual({
      kind: 'taken',
      owner,
      asAlias: false,
    });
    expect(errorOf(tags.renameTag(lyon, 'PANAME', true))).toEqual({
      kind: 'taken',
      owner,
      asAlias: true,
    });
    expect(tags.get(lyon)).toMatchObject({ name: 'Lyon', aliases: [] });
  });

  it('keeps the old name of a renamed tag as an alias only when asked', () => {
    const { tags, addTag } = createCheckedLibrary();
    const city = addTag('Constantinople');
    const town = addTag('Paris');

    expect(editedTag(tags.renameTag(city, 'Istanbul', true))).toMatchObject({
      name: 'Istanbul',
      aliases: ['Constantinople'],
    });
    expect(editedTag(tags.renameTag(town, 'Lutèce', false))).toMatchObject({
      name: 'Lutèce',
      aliases: [],
    });
    // A name that was not kept is free again; a kept one is not.
    expect(tags.resolve(['Paris', 'Constantinople'])).toEqual([
      null,
      { id: city, name: 'Istanbul', viaAlias: true },
    ]);
  });

  it('keeps a tag made by tagging a file once it is renamed', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Pariis']);
    const paris = idOf(tags, 'Pariis');

    tags.renameTag(paris, 'Paris', false);

    // Renamed on purpose: it no longer goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.list().map((tag) => tag.name)).toEqual(['Paris']);
  });

  it('keeps a tag made by tagging a file once it is renamed with its old name as an alias', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Pariis']);
    const paris = idOf(tags, 'Pariis');

    tags.renameTag(paris, 'Paris', true);

    tags.removeFromFiles([a], [paris]);
    expect(tags.list()).toMatchObject([{ name: 'Paris', aliases: ['Pariis'] }]);
  });

  it('refuses to keep the old name of a tag that has all the aliases a tag may have', () => {
    const { tags, addTag } = createCheckedLibrary();
    const full = addTag('Full', {
      aliases: Array.from({ length: MAX_TAG_ALIASES }, (_, index) => `alias ${index}`),
    });

    expect(errorOf(tags.renameTag(full, 'Fuller', true))).toEqual({
      kind: 'limit',
      what: 'aliases',
    });
    expect(tags.get(full)).toMatchObject({ name: 'Full' });
    expect(tags.resolve(['Fuller'])).toEqual([null]);
    // Without keeping it, and by swapping with an alias, it has no more aliases than before.
    expect(tags.renameTag(full, 'Fuller', false)).toMatchObject({ ok: true });
    expect(tags.renameTag(full, 'alias 7', false)).toMatchObject({ ok: true });
    expect(tags.get(full)?.aliases).toHaveLength(MAX_TAG_ALIASES);
  });

  it('gives a tag aliases, which no other tag can then take', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Paris']);
    const paris = idOf(tags, 'Paris');
    const lyon = editedTag(tags.createTag('Lyon')).id;

    tags.addAlias(paris, '  Ville   Lumière ');
    expect(editedTag(tags.addAlias(paris, 'Paname'))).toEqual({
      id: paris,
      name: 'Paris',
      aliases: ['Paname', 'Ville Lumière'],
      parentIds: [],
      fileCount: 1,
    });
    const owner = { id: paris, name: 'Paris' };
    expect(errorOf(tags.addAlias(lyon, 'paname'))).toEqual({ kind: 'taken', owner, asAlias: true });
    expect(errorOf(tags.addAlias(lyon, 'PARIS'))).toEqual({ kind: 'taken', owner, asAlias: false });
    expect(tags.get(lyon)?.aliases).toEqual([]);
    // Given an alias on purpose: the tag no longer goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.get(paris)).toMatchObject({ name: 'Paris', fileCount: 0 });
  });

  it('changes nothing when a tag is given a name it already has', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['Paris']);
    tags.addToFiles([b], ['Lyon']);
    const paris = idOf(tags, 'Paris');
    const lyon = idOf(tags, 'Lyon');
    tags.addAlias(lyon, 'Lugdunum');

    expect(editedTag(tags.addAlias(paris, 'PARIS'))).toMatchObject({ name: 'Paris', aliases: [] });
    expect(editedTag(tags.addAlias(lyon, 'LUGDUNUM'))).toMatchObject({ aliases: ['Lugdunum'] });
    // Not edited: the tag still goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.get(paris)).toBeNull();
  });

  it('changes nothing when a tag is given a name it already has but for a character nobody sees', () => {
    const { db, tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Paris']);
    const paris = idOf(tags, 'Paris');
    const lyon = addTag('Lyon', { aliases: ['Lugdunum'] });
    const before = storedRows(db);

    // Its own name with a zero-width space, its alias with a soft hyphen.
    expect(editedTag(tags.addAlias(paris, 'Paris\u200B'))).toMatchObject({
      name: 'Paris',
      aliases: [],
    });
    expect(editedTag(tags.addAlias(lyon, 'Lug\u00ADdunum'))).toMatchObject({
      aliases: ['Lugdunum'],
    });
    // Nor does another tag get it, as an alias or as its name.
    expect(errorOf(tags.addAlias(lyon, '\u2060Paris'))).toEqual({
      kind: 'taken',
      owner: { id: paris, name: 'Paris' },
      asAlias: false,
    });
    expect(errorOf(tags.renameTag(paris, 'Lugdunum\u200B', false))).toEqual({
      kind: 'taken',
      owner: { id: lyon, name: 'Lyon' },
      asAlias: true,
    });
    expect(storedRows(db)).toEqual(before);
    // Not edited: the tag still goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.get(paris)).toBeNull();
  });

  it('finds an alias to take away and a parent by a name typed with characters nobody sees', () => {
    const { db, tags, addTag } = createCheckedLibrary();
    const france = addTag('France', { aliases: ['Hexagone', 'FR'] });
    const paris = addTag('Paris');

    expect(editedTag(tags.removeAlias(france, 'Hexa\u00ADgone')).aliases).toEqual(['FR']);
    // The parent is the tag there is, by its name or an alias: none is made of the name as typed.
    expect(editedTag(tags.addParent(paris, 'Fra\u00ADnce')).parentIds).toEqual([france]);
    expect(editedTag(tags.addParent(paris, '\u200Bfr\u200B')).parentIds).toEqual([france]);
    expect(storedLinks(db)).toEqual([[paris, france]]);
    expect(tags.count()).toBe(2);
    // The tag itself, typed with one, is still no parent of its own.
    expect(errorOf(tags.addParent(paris, 'Paris\u2060'))).toMatchObject({ kind: 'loop' });
  });

  it('refuses more aliases than a tag may have', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris');
    for (let index = 0; index < MAX_TAG_ALIASES; index++) {
      expect(tags.addAlias(paris, `alias ${index}`)).toMatchObject({ ok: true });
    }

    expect(errorOf(tags.addAlias(paris, 'one too many'))).toEqual({
      kind: 'limit',
      what: 'aliases',
    });
    expect(tags.resolve(['one too many'])).toEqual([null]);
    // One it already has is still no change.
    expect(tags.addAlias(paris, 'Alias 3')).toMatchObject({ ok: true });
  });

  it('takes an alias from a tag, and never its name', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { aliases: ['Paname', 'Lutèce'] });
    const lyon = addTag('Lyon', { aliases: ['Lugdunum'] });

    expect(editedTag(tags.removeAlias(paris, 'PANAME'))).toMatchObject({ aliases: ['Lutèce'] });
    // Not an alias of this tag: its name, an alias of another tag, no name at all.
    for (const name of ['Paris', 'Lugdunum', 'Marseille', 'a, b']) {
      expect(editedTag(tags.removeAlias(paris, name))).toMatchObject({
        name: 'Paris',
        aliases: ['Lutèce'],
      });
    }
    expect(tags.get(lyon)?.aliases).toEqual(['Lugdunum']);
    // The name is free again.
    expect(tags.addAlias(lyon, 'Paname')).toMatchObject({ ok: true });
  });

  it('puts a tag below others, found by their name or an alias', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Paris', 'France']);
    const paris = idOf(tags, 'Paris');
    const france = idOf(tags, 'France');
    const capitals = addTag('Capitals', { aliases: ['Capital cities'] });

    tags.addParent(paris, 'france');
    expect(editedTag(tags.addParent(paris, 'capital   cities'))).toEqual({
      id: paris,
      name: 'Paris',
      aliases: [],
      parentIds: [capitals, france],
      fileCount: 1,
    });
    // Both ends of a link are tags edited on purpose: neither goes with its last file.
    tags.removeFromFiles([a], [paris, france]);
    expect(tags.list().map((tag) => tag.name)).toEqual(['Capitals', 'France', 'Paris']);
  });

  it('makes the parent when no tag has its name', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const paris = addTag('Paris');
    tags.addToFiles([a], ['typo']);

    const edited = editedTag(tags.addParent(paris, '  France '));

    expect(tags.resolve(['France'])).toMatchObject([{ name: 'France', viaAlias: false }]);
    expect(edited.parentIds).toEqual([idOf(tags, 'France')]);
    // Made on purpose: it stays without a file.
    tags.removeFromFiles(
      [a],
      tags.forFile(a).map((tag) => tag.id),
    );
    expect(tags.list().map((tag) => tag.name)).toEqual(['France', 'Paris']);
  });

  it('changes nothing when a tag is given a parent it already has', () => {
    const { db, tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { parents: ['France'] });
    const before = storedLinks(db);

    expect(editedTag(tags.addParent(paris, 'FRANCE')).parentIds).toHaveLength(1);
    expect(storedLinks(db)).toEqual(before);
  });

  it('refuses a tag as its own parent, by its name or an alias', () => {
    const { db, tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { aliases: ['Paname'] });
    const self = { id: paris, name: 'Paris' };

    for (const name of ['Paris', 'paname']) {
      expect(errorOf(tags.addParent(paris, name))).toEqual({
        kind: 'loop',
        above: self,
        below: self,
        through: null,
      });
    }
    expect(storedLinks(db)).toEqual([]);
  });

  it('refuses a tag below it as a parent, naming the tag in between', () => {
    const { db, tags, addTag } = createCheckedLibrary();
    const europe = addTag('Europe');
    const france = addTag('France', { parents: ['Europe'] });
    const region = addTag('Île-de-France', { parents: ['France'] });
    const paris = addTag('Paris', { parents: ['Île-de-France'], aliases: ['Paname'] });
    const before = storedLinks(db);
    const above = { id: europe, name: 'Europe' };

    // A child tag: nothing in between.
    expect(errorOf(tags.addParent(europe, 'France'))).toEqual({
      kind: 'loop',
      above,
      below: { id: france, name: 'France' },
      through: null,
    });
    // Further below: through the child tag that leads down to it.
    expect(errorOf(tags.addParent(europe, 'paname'))).toEqual({
      kind: 'loop',
      above,
      below: { id: paris, name: 'Paris' },
      through: { id: france, name: 'France' },
    });
    expect(errorOf(tags.addParent(france, 'Paris'))).toEqual({
      kind: 'loop',
      above: { id: france, name: 'France' },
      below: { id: paris, name: 'Paris' },
      through: { id: region, name: 'Île-de-France' },
    });
    expect(storedLinks(db)).toEqual(before);
  });

  it('names no tag in between for a child tag that is also further below', () => {
    const { tags, addTag } = createCheckedLibrary();
    const europe = addTag('Europe');
    addTag('France', { parents: ['Europe'] });
    const paris = addTag('Paris', { parents: ['France', 'Europe'] });

    expect(errorOf(tags.addParent(europe, 'Paris'))).toEqual({
      kind: 'loop',
      above: { id: europe, name: 'Europe' },
      below: { id: paris, name: 'Paris' },
      through: null,
    });
  });

  it('lets a tag be put below a tag that is beside it or above it another way', () => {
    const { tags, addTag } = createCheckedLibrary();
    const europe = addTag('Europe');
    const france = addTag('France', { parents: ['Europe'] });
    const paris = addTag('Paris', { parents: ['France'] });
    const capitals = addTag('Capitals', { parents: ['Europe'] });

    expect(editedTag(tags.addParent(paris, 'Capitals')).parentIds).toEqual([capitals, france]);
    // Already above it through France: allowed, though it adds nothing to a search.
    expect(editedTag(tags.addParent(paris, 'Europe')).parentIds).toEqual([
      capitals,
      europe,
      france,
    ]);
  });

  it('refuses more parents than a tag may have, and leaves no tag behind', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris');
    for (let index = 0; index < MAX_TAG_PARENTS; index++) {
      expect(tags.addParent(paris, `parent ${index}`)).toMatchObject({ ok: true });
    }
    const count = tags.count();

    expect(errorOf(tags.addParent(paris, 'one too many'))).toEqual({
      kind: 'limit',
      what: 'parents',
    });
    expect(tags.resolve(['one too many'])).toEqual([null]);
    expect(tags.count()).toBe(count);
    // One it already has is still no change.
    expect(tags.addParent(paris, 'Parent 3')).toMatchObject({ ok: true });
  });

  it('takes a parent from a tag, leaving both tags', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { parents: ['France', 'Capitals'] });
    const france = idOf(tags, 'France');
    const capitals = idOf(tags, 'Capitals');

    expect(editedTag(tags.removeParent(paris, france)).parentIds).toEqual([capitals]);
    // Not its parent: no longer one, the tag itself, no tag at all, and its child tag.
    for (const parentId of [france, paris, 999]) {
      expect(editedTag(tags.removeParent(paris, parentId)).parentIds).toEqual([capitals]);
    }
    expect(editedTag(tags.removeParent(capitals, paris)).parentIds).toEqual([]);
    expect(tags.get(paris)?.parentIds).toEqual([capitals]);
    expect(tags.count()).toBe(3);
  });

  it('deletes a tag: its files lose it, and its name and aliases are free again', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const paris = addTag('Paris', { aliases: ['Paname'] });
    tags.addToFiles([a], ['Paris', 'Beach']);

    expect(tags.deleteTag(paris)).toEqual({ ok: true });

    expect(tags.get(paris)).toBeNull();
    expect(tags.forFile(a).map((tag) => tag.name)).toEqual(['Beach']);
    expect(tags.resolve(['Paris', 'Paname'])).toEqual([null, null]);
    expect(tags.deleteTag(paris)).toEqual({ ok: false, error: { kind: 'gone' } });
  });

  it('moves the child tags of a deleted tag up to each of its parents', () => {
    const { tags, addTag } = createCheckedLibrary();
    const france = addTag('France', { parents: ['Europe', 'Countries'] });
    const paris = addTag('Paris', { parents: ['France', 'Capitals'] });
    const lyon = addTag('Lyon', { parents: ['France', 'Europe'] });
    const capitals = idOf(tags, 'Capitals');
    const countries = idOf(tags, 'Countries');
    const europe = idOf(tags, 'Europe');

    tags.deleteTag(france);

    expect(tags.get(paris)?.parentIds).toEqual([capitals, countries, europe]);
    // A parent it had already is its parent once.
    expect(tags.get(lyon)?.parentIds).toEqual([countries, europe]);
  });

  it('keeps a chain whole when a tag in the middle of it is deleted', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const europe = addTag('Europe');
    const france = addTag('France', { parents: ['Europe'] });
    const paris = addTag('Paris', { parents: ['France'] });
    tags.attach([addFile('a.jpg')], [paris]);
    expect(tags.details(europe)).toMatchObject({ tagsBelow: 2, filesWithBelow: 1 });

    tags.deleteTag(france);

    expect(tags.get(paris)?.parentIds).toEqual([europe]);
    expect(tags.details(europe)).toMatchObject({ tagsBelow: 1, filesWithBelow: 1 });
  });

  it('leaves the child tags of a deleted tag without a parent when it had none', () => {
    const { tags, addTag } = createCheckedLibrary();
    const france = addTag('France');
    const paris = addTag('Paris', { parents: ['France'] });

    tags.deleteTag(france);

    expect(tags.list()).toEqual([
      { id: paris, name: 'Paris', aliases: [], parentIds: [], fileCount: 0 },
    ]);
  });

  it('refuses to delete a tag when a child tag would then have more parents than a tag may', () => {
    const { db, tags, addTag } = createCheckedLibrary();
    const france = addTag('France', { parents: ['Europe', 'Countries'] });
    const paris = addTag('Paris', {
      parents: [
        'France',
        ...Array.from({ length: MAX_TAG_PARENTS - 1 }, (_, index) => `parent ${index}`),
      ],
    });
    const lyon = addTag('Lyon', { parents: ['France'] });
    const before = storedRows(db);

    // Paris would have one parent too many: all it has but France, and the two of France. Lyon
    // would not, and stays where it is all the same.
    expect(errorOf(tags.deleteTag(france))).toEqual({ kind: 'limit', what: 'parents' });
    expect(storedRows(db)).toEqual(before);

    // As many as a tag may have is not too many: Paris has one of the two parents of France
    // already, which counts once.
    tags.removeParent(france, idOf(tags, 'Countries'));
    tags.addParent(france, 'parent 0');
    expect(tags.deleteTag(france)).toEqual({ ok: true });
    expect(tags.get(paris)?.parentIds).toHaveLength(MAX_TAG_PARENTS);
    expect(tags.get(lyon)?.parentIds).toEqual([idOf(tags, 'Europe'), idOf(tags, 'parent 0')]);
  });

  it('merges a tag into another: its files, and its name and aliases as aliases', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    const both = addFile('both.jpg');
    tags.addToFiles([a, both], ['NYC']);
    tags.addToFiles([b, both], ['New York']);
    const nyc = addTag('NYC', { aliases: ['Big Apple'] });
    const newYork = idOf(tags, 'New York');

    // A file that carries both tags carries the kept one once.
    expect(editedTag(tags.mergeTags(nyc, newYork))).toEqual({
      id: newYork,
      name: 'New York',
      aliases: ['Big Apple', 'NYC'],
      parentIds: [],
      fileCount: 3,
    });
    expect(tags.get(nyc)).toBeNull();
    expect(tags.forFile(a)).toEqual([{ id: newYork, name: 'New York' }]);
    expect(tags.forFile(both)).toEqual([{ id: newYork, name: 'New York' }]);
    expect(tags.resolve(['nyc'])).toEqual([{ id: newYork, name: 'New York', viaAlias: true }]);
    // The kept tag was edited on purpose: it no longer goes with its last file.
    tags.removeFromFiles([a, b, both], [newYork]);
    expect(tags.count()).toBe(1);
  });

  it('merges two tags that have a child tag in common', () => {
    const { tags, addTag } = createCheckedLibrary();
    const nyc = addTag('NYC');
    const newYork = addTag('New York');
    const manhattan = addTag('Manhattan', { parents: ['NYC', 'New York'] });
    const queens = addTag('Queens', { parents: ['NYC'] });

    expect(tags.mergeTags(nyc, newYork)).toMatchObject({ ok: true });

    expect(tags.get(manhattan)?.parentIds).toEqual([newYork]);
    expect(tags.get(queens)?.parentIds).toEqual([newYork]);
    expect(tags.details(newYork)?.children.map((tag) => tag.name)).toEqual(['Manhattan', 'Queens']);
  });

  it('merges two tags that have a parent in common', () => {
    const { tags, addTag } = createCheckedLibrary();
    const nyc = addTag('NYC', { parents: ['USA', 'Cities'] });
    const newYork = addTag('New York', { parents: ['USA', 'East Coast'] });

    expect(editedTag(tags.mergeTags(nyc, newYork)).parentIds).toEqual(
      ['Cities', 'East Coast', 'USA'].map((name) => idOf(tags, name)),
    );
  });

  it('merges a child tag into its parent, and a parent into its child tag', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const world = addTag('World');
    const france = addTag('France', { parents: ['World'] });
    const hexagone = addTag('Hexagone', { parents: ['France'] });
    const paris = addTag('Paris', { parents: ['Hexagone'] });
    tags.attach([a], [hexagone]);

    // The child tag into its parent: the link between the two is dropped.
    expect(editedTag(tags.mergeTags(hexagone, france))).toEqual({
      id: france,
      name: 'France',
      aliases: ['Hexagone'],
      parentIds: [world],
      fileCount: 1,
    });
    expect(tags.get(paris)?.parentIds).toEqual([france]);

    // The parent into its child tag: the child tag takes its place.
    expect(editedTag(tags.mergeTags(france, paris))).toEqual({
      id: paris,
      name: 'Paris',
      aliases: ['France', 'Hexagone'],
      parentIds: [world],
      fileCount: 1,
    });
    expect(tags.details(world)).toMatchObject({ tagsBelow: 1, filesWithBelow: 1 });
  });

  it('refuses to merge two tags with a tag in between, whichever is kept', () => {
    const { db, tags, addFile, addTag } = createCheckedLibrary();
    const europe = addTag('Europe', { aliases: ['EU'] });
    const france = addTag('France', { parents: ['Europe'] });
    const paris = addTag('Paris', { parents: ['France'] });
    tags.attach([addFile('a.jpg')], [paris]);
    const loop = {
      kind: 'loop',
      above: { id: europe, name: 'Europe' },
      below: { id: paris, name: 'Paris' },
      through: { id: france, name: 'France' },
    };
    const stored = (): unknown => ({ links: storedLinks(db), tags: tags.list() });
    const chain = stored();

    expect(errorOf(tags.mergeTags(paris, europe))).toEqual(loop);
    expect(errorOf(tags.mergeTags(europe, paris))).toEqual(loop);
    expect(stored()).toEqual(chain);
    // A link between the two themselves does not help: France would still be in between.
    tags.addParent(paris, 'Europe');
    const linked = stored();
    expect(errorOf(tags.mergeTags(paris, europe))).toEqual(loop);
    expect(errorOf(tags.mergeTags(europe, paris))).toEqual(loop);
    expect(stored()).toEqual(linked);
  });

  it('carries the aliases of a merged tag along when the kept tag is merged in turn', () => {
    const { tags, addTag } = createCheckedLibrary();
    const a = addTag('A', { aliases: ['a too'] });
    const b = addTag('B');
    const c = addTag('C');

    tags.mergeTags(a, b);
    expect(editedTag(tags.mergeTags(b, c))).toMatchObject({
      id: c,
      name: 'C',
      aliases: ['A', 'a too', 'B'],
    });
    expect(tags.resolve(['a'])).toEqual([{ id: c, name: 'C', viaAlias: true }]);
    expect(tags.count()).toBe(1);
  });

  it('changes nothing when a tag is merged into itself', () => {
    const { tags, addFile } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Paris']);
    const paris = idOf(tags, 'Paris');

    expect(editedTag(tags.mergeTags(paris, paris))).toMatchObject({ name: 'Paris', fileCount: 1 });
    // Not edited: the tag still goes with its last file.
    tags.removeFromFiles([a], [paris]);
    expect(tags.get(paris)).toBeNull();
  });

  it('refuses a merge that would give the kept tag more aliases than a tag may have', () => {
    const { tags, addTag } = createCheckedLibrary();
    const aliases = (prefix: string, length: number): string[] =>
      Array.from({ length }, (_, index) => `${prefix} ${index}`);
    const kept = addTag('Kept', { aliases: aliases('kept', 60) });
    // Its name counts too: 60 + 1 + 40 is one too many.
    const tooMany = addTag('Too many', { aliases: aliases('too many', 40) });
    const justEnough = addTag('Just enough', { aliases: aliases('just enough', 39) });

    expect(errorOf(tags.mergeTags(tooMany, kept))).toEqual({ kind: 'limit', what: 'aliases' });
    expect(tags.get(tooMany)?.aliases).toHaveLength(40);
    expect(tags.get(kept)?.aliases).toHaveLength(60);
    expect(editedTag(tags.mergeTags(justEnough, kept)).aliases).toHaveLength(MAX_TAG_ALIASES);
  });

  it('leaves a tag made by tagging a file as it was when a merge into it is refused', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    tags.addToFiles([a], ['Made by tagging']);
    const madeByTagging = idOf(tags, 'Made by tagging');
    const full = addTag('Full', {
      aliases: Array.from({ length: MAX_TAG_ALIASES }, (_, index) => `alias ${index}`),
    });

    // The name of the merged tag would be one alias too many.
    expect(errorOf(tags.mergeTags(full, madeByTagging))).toEqual({
      kind: 'limit',
      what: 'aliases',
    });
    // Not edited: the tag still goes with its last file.
    tags.removeFromFiles([a], [madeByTagging]);
    expect(tags.get(madeByTagging)).toBeNull();
  });

  it('refuses a merge that would give the kept tag more parents than a tag may have', () => {
    const { tags, addTag } = createCheckedLibrary();
    const parents = (from: number, to: number): string[] =>
      Array.from({ length: to - from }, (_, index) => `parent ${from + index}`);
    const kept = addTag('Kept', { parents: parents(0, 60) });
    // Parents the two have in common count once: 60 + 41 others is one too many.
    const tooMany = addTag('Too many', { parents: parents(50, 101) });
    const justEnough = addTag('Just enough', { parents: parents(50, 100) });

    expect(errorOf(tags.mergeTags(tooMany, kept))).toEqual({ kind: 'limit', what: 'parents' });
    expect(tags.get(tooMany)?.parentIds).toHaveLength(51);
    expect(tags.get(kept)?.parentIds).toHaveLength(60);
    expect(editedTag(tags.mergeTags(justEnough, kept)).parentIds).toHaveLength(MAX_TAG_PARENTS);

    // A parent merged into its child tag is no longer one of its parents: it does not count.
    const child = addTag('Child', { parents: ['Above', ...parents(0, 99)] });
    const above = addTag('Above', { parents: ['Higher still'] });
    expect(editedTag(tags.mergeTags(above, child)).parentIds).toHaveLength(MAX_TAG_PARENTS);
  });

  // CPU-heavy: the full parallel run multiplies its time, past the default timeout of 5 s.
  it('never stores a loop, and refuses a parent or a merge only when it would make one', () => {
    const random = seededRandom(20_261_115);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const names = Array.from({ length: 10 }, (_, index) => `tag ${index}`);
    const { db, tags } = createTestLibrary();
    const stored = linksReader(db);

    for (let graph = 0; graph < 300; graph++) {
      // One library for every graph, emptied of the tags of the graph before: opening a library
      // takes longer than a graph does.
      for (const { id } of tags.list()) {
        tags.deleteTag(id);
      }
      // What must be stored, kept by plain bookkeeping beside the repository: the tag each name
      // stands for (the name of a tag merged away is an alias of the tag kept) and the links.
      let owners = names.map((name) => ({ name, id: editedTag(tags.createTag(name)).id }));
      let links: Link[] = [];
      for (let step = 0; step < 20; step++) {
        const at = `graph ${graph}, step ${step}`;
        const tag = pick(owners).id;
        const other = pick(owners);
        const merging = random() < 0.2;
        // A tag as its own parent is a loop; merged into itself, it is left as it is.
        const wanted = merging ? mergedLinks(links, tag, other.id) : withLink(links, tag, other.id);
        const error = errorOf(
          merging ? tags.mergeTags(tag, other.id) : tags.addParent(tag, other.name),
        );

        if (hasLoop(wanted)) {
          expect(error, at).toMatchObject({ kind: 'loop' });
          if (error?.kind === 'loop') {
            // The error tells the truth: `below` is below `above`, through the tag it names.
            const { above, below, through } = error;
            expect(new Set([above.id, below.id]), at).toEqual(new Set([tag, other.id]));
            expect(above.id === below.id || isBelow(links, below.id, above.id), at).toBe(true);
            if (through) {
              expect(hasLink(links, through.id, above.id), at).toBe(true);
              expect(isBelow(links, below.id, through.id), at).toBe(true);
            } else {
              expect(merging, at).toBe(false);
              expect(above.id === below.id || hasLink(links, below.id, above.id), at).toBe(true);
            }
          }
        } else {
          expect(error, at).toBeNull();
          links = wanted;
          if (merging) {
            owners = owners.map((owner) => (owner.id === tag ? { ...owner, id: other.id } : owner));
          }
        }
        // No loop is stored: the links kept beside never hold one.
        expect(new Set(stored().map(String)), at).toEqual(new Set(links.map(String)));
      }
      expect(tags.resolve(names).map((found) => found?.id)).toEqual(owners.map(({ id }) => id));
      expectSoundTags(db);
    }
  }, 30_000);

  it('leaves nothing of a change that fails halfway, not even a parent made on the way', () => {
    const { db, tags, addFile, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { aliases: ['Paname'], parents: ['France'] });
    const lyon = addTag('Lyon', { parents: ['France'] });
    tags.attach([addFile('a.jpg')], [lyon]);
    const before = storedRows(db);
    /** Expects `change` to fail when the database refuses `event`, a kind of write to a table. */
    const expectFailure = (event: string, change: () => unknown): void => {
      db.exec(`
        CREATE TEMP TRIGGER made_to_fail BEFORE ${event}
        BEGIN SELECT RAISE(ABORT, 'made to fail'); END`);
      try {
        expect(change).toThrow('made to fail');
      } finally {
        db.exec('DROP TRIGGER made_to_fail');
      }
    };

    // The parent is made first, then the link to it fails.
    expectFailure('INSERT ON tag_parents', () => tags.addParent(paris, 'New parent'));
    expect(tags.resolve(['New parent'])).toEqual([null]);
    expect(storedRows(db)).toEqual(before);

    // Its files, parents, child tags and names have moved when the merged tag fails to go.
    expectFailure('DELETE ON tags', () => tags.mergeTags(lyon, paris));
    expect(storedRows(db)).toEqual(before);
  });

  it('never gives the id of a tag that is gone to another tag', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const a = addFile('a.jpg');
    const deleted = addTag('Deleted');
    tags.deleteTag(deleted);
    tags.addToFiles([a], ['Gone with its last file']);
    const cleanedUp = idOf(tags, 'Gone with its last file');
    tags.removeFromFiles([a], [cleanedUp]);
    const merged = addTag('Merged');
    const kept = addTag('Kept');
    tags.mergeTags(merged, kept);
    const next = addTag('Deleted');

    expect(tags.list().map((tag) => tag.id)).toEqual([next, kept]);
    // Each id is above every id given before it, whatever became of its tag.
    const ids = [deleted, cleanedUp, merged, kept, next];
    expect(ids).toEqual([...new Set(ids)].sort((x, y) => x - y));
  });

  it('answers that a tag is gone to any change to a tag that no longer exists', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris');
    const gone = { ok: false, error: { kind: 'gone' } };

    expect(tags.renameTag(999, 'Lyon', false)).toEqual(gone);
    expect(tags.addAlias(999, 'Lyon')).toEqual(gone);
    expect(tags.removeAlias(999, 'Lyon')).toEqual(gone);
    expect(tags.addParent(999, 'Paris')).toEqual(gone);
    expect(tags.removeParent(999, paris)).toEqual(gone);
    expect(tags.deleteTag(999)).toEqual(gone);
    expect(tags.mergeTags(999, paris)).toEqual(gone);
    expect(tags.mergeTags(paris, 999)).toEqual(gone);
    expect(tags.mergeTags(999, 999)).toEqual(gone);
    expect(tags.details(999)).toBeNull();
    // Gone comes first: a name that cannot be one is not looked at.
    expect(tags.renameTag(999, 'a, b', false)).toEqual(gone);
    expect(tags.list()).toEqual([
      { id: paris, name: 'Paris', aliases: [], parentIds: [], fileCount: 0 },
    ]);
  });

  it('counts what a tag stands for: its own files, and those of the tags below it', () => {
    const { tags, addFile, addTag } = createCheckedLibrary();
    const europe = addTag('Europe');
    const france = addTag('France', { parents: ['Europe'], aliases: ['Hexagone'] });
    const paris = addTag('Paris', { parents: ['France'] });
    const lyon = addTag('Lyon', { parents: ['France'] });
    // Below Europe twice over: counted once.
    const capitals = addTag('Capitals', { parents: ['Europe'] });
    tags.addParent(paris, 'Capitals');
    tags.attach([addFile('paris.jpg')], [paris]);
    tags.attach([addFile('paris-and-france.jpg')], [paris, france]);
    tags.attach([addFile('europe.jpg')], [europe]);
    tags.attach([addFile('lyon.jpg')], [lyon]);
    // Missing from disk: one kept for this tag only, one that has another tag too.
    tags.attach([addFile('gone.jpg', { missingSince: 1 })], [france]);
    tags.attach([addFile('gone-too.jpg', { missingSince: 1 })], [france, lyon]);

    expect(tags.details(france)).toEqual({
      tag: {
        id: france,
        name: 'France',
        aliases: ['Hexagone'],
        parentIds: [europe],
        fileCount: 3,
      },
      parents: [{ id: europe, name: 'Europe' }],
      children: [
        { id: lyon, name: 'Lyon' },
        { id: paris, name: 'Paris' },
      ],
      tagsBelow: 2,
      ownFiles: 1,
      filesWithBelow: 3,
      taggedFiles: 3,
      forgottenFiles: 1,
    });
    expect(tags.details(europe)).toMatchObject({
      parents: [],
      children: [
        { id: capitals, name: 'Capitals' },
        { id: france, name: 'France' },
      ],
      tagsBelow: 4,
      ownFiles: 1,
      filesWithBelow: 4,
      taggedFiles: 1,
      forgottenFiles: 0,
    });
    expect(tags.details(lyon)).toMatchObject({
      children: [],
      tagsBelow: 0,
      ownFiles: 1,
      filesWithBelow: 1,
      taggedFiles: 2,
      forgottenFiles: 0,
    });
  });

  it('reads the names of one tag through the index on tag ids, not by reading every name', () => {
    const { db } = createTestLibrary();
    const prepared = vi.spyOn(db, 'prepare');
    // Only for the statements it prepares.
    new TagsRepository(db);
    const reads = prepared.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /\bFROM tag_names WHERE tag_id = \?/.test(sql));

    // The name and the aliases of a tag, its name alone, and how many aliases it has.
    expect(reads).toHaveLength(3);
    for (const sql of reads) {
      const plan = db
        .prepare<[number], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(1)
        .map((step) => step.detail);
      expect(plan, sql).toEqual([
        expect.stringMatching(
          /^SEARCH tag_names USING (COVERING )?INDEX tag_names_tag \(tag_id=\?/,
        ),
      ]);
    }
  });
});

/** The tags of the library as a tags export says them: each name, aliases and parent tags. */
function describedTags(
  tags: TagsRepository,
): { name: string; aliases: string[]; parents: string[] }[] {
  const list = tags.list();
  const names = new Map(list.map((tag) => [tag.id, tag.name]));
  return list.map(({ name, aliases, parentIds }) => ({
    name,
    aliases: [...aliases],
    parents: parentIds.map((id) => names.get(id) ?? '?'),
  }));
}

describe('TagsRepository.applyDefinitions', () => {
  it('makes the tags described, with their aliases and parent tags', () => {
    const { tags } = createCheckedLibrary();

    const applied = tags.applyDefinitions(
      [
        { name: 'Paris', aliases: ['Paname'], parents: ['France'] },
        { name: 'France', aliases: [], parents: ['Europe'] },
      ],
      false,
    );

    expect(describedTags(tags)).toEqual([
      { name: 'Europe', aliases: [], parents: [] },
      { name: 'France', aliases: [], parents: ['Europe'] },
      { name: 'Paris', aliases: ['Paname'], parents: ['France'] },
    ]);
    const paris = idOf(tags, 'Paris');
    const france = idOf(tags, 'France');
    const europe = idOf(tags, 'Europe');
    expect(applied).toEqual({
      named: new Map([
        ['paris', paris],
        ['paname', paris],
        ['france', france],
        ['europe', europe],
      ]),
      // The tags described first, then the parent tags that none describes.
      created: ['Paris', 'France', 'Europe'],
      aliases: [{ tag: 'Paris', alias: 'Paname' }],
      links: [
        { tag: 'Paris', parent: 'France', tagId: paris, parentId: france },
        { tag: 'France', parent: 'Europe', tagId: france, parentId: europe },
      ],
      knownAs: [],
      skipped: [],
    });
    // Made on purpose: no file is needed to keep them.
    expect(tags.cleanup()).toBe(0);
  });

  it('tells in a dry run what it would add, and writes nothing', () => {
    const { tags, db } = createCheckedLibrary();
    const definitions = [
      { name: 'Paris', aliases: ['Paname'], parents: ['France'] },
      { name: 'France', aliases: [], parents: ['Europe'] },
    ];
    const before = storedRows(db);

    const dry = tags.applyDefinitions(definitions, true);

    expect(storedRows(db)).toEqual(before);
    // A tag still to make stands for the key of its name, and has no id.
    expect(dry).toEqual({
      named: new Map([
        ['paris', 'paris'],
        ['paname', 'paris'],
        ['france', 'france'],
        ['europe', 'europe'],
      ]),
      created: ['Paris', 'France', 'Europe'],
      aliases: [{ tag: 'Paris', alias: 'Paname' }],
      links: [
        { tag: 'Paris', parent: 'France', tagId: null, parentId: null },
        { tag: 'France', parent: 'Europe', tagId: null, parentId: null },
      ],
      knownAs: [],
      skipped: [],
    });
    // Then does what it said.
    const applied = tags.applyDefinitions(definitions, false);
    expect({ ...applied, named: null, links: null }).toEqual({ ...dry, named: null, links: null });
  });

  it('adds to the tags of the library only what they lack', () => {
    const { tags, addTag, db } = createCheckedLibrary();
    addTag('Paris', { aliases: ['Paname'], parents: ['France'] });
    const before = storedRows(db);

    // What the library has already changes nothing, whatever its letter case.
    expect(
      tags.applyDefinitions([{ name: 'PARIS', aliases: ['paname'], parents: ['france'] }], false),
    ).toMatchObject({ created: [], aliases: [], links: [], knownAs: [], skipped: [] });
    expect(storedRows(db)).toEqual(before);

    expect(
      tags.applyDefinitions(
        [{ name: 'Paris', aliases: ['Paname', 'Lutèce'], parents: ['France', 'Europe'] }],
        false,
      ),
    ).toMatchObject({
      created: ['Europe'],
      aliases: [{ tag: 'Paris', alias: 'Lutèce' }],
      links: [{ tag: 'Paris', parent: 'Europe' }],
    });
    expect(describedTags(tags)).toEqual([
      { name: 'Europe', aliases: [], parents: [] },
      { name: 'France', aliases: [], parents: [] },
      { name: 'Paris', aliases: ['Lutèce', 'Paname'], parents: ['Europe', 'France'] },
    ]);
  });

  it('takes a tag known here under another name for that tag, which gets the name as an alias', () => {
    const { tags, addTag } = createCheckedLibrary();
    addTag('Lutetia', { aliases: ['Paname'] });
    addTag('Byzantium', { aliases: ['CONSTANTINOPLE'] });

    const applied = tags.applyDefinitions(
      [
        // Through an alias it has here: Paris becomes an alias of Lutetia.
        { name: 'Paris', aliases: ['Paname', 'Lutèce'], parents: [] },
        // Through its name, an alias here: Byzantium gets nothing more.
        { name: 'Constantinople', aliases: [], parents: [] },
      ],
      false,
    );

    expect(applied).toMatchObject({
      created: [],
      aliases: [
        { tag: 'Lutetia', alias: 'Paris' },
        { tag: 'Lutetia', alias: 'Lutèce' },
      ],
      knownAs: [
        { exported: 'Paris', tag: 'Lutetia' },
        { exported: 'Constantinople', tag: 'Byzantium' },
      ],
      skipped: [],
    });
    expect(describedTags(tags)).toEqual([
      { name: 'Byzantium', aliases: ['CONSTANTINOPLE'], parents: [] },
      { name: 'Lutetia', aliases: ['Lutèce', 'Paname', 'Paris'], parents: [] },
    ]);
  });

  it('makes a tag of a name whose aliases are names of several tags here, and says which', () => {
    const { tags, addTag } = createCheckedLibrary();
    addTag('Lyon');
    addTag('Marseille');

    expect(
      tags.applyDefinitions(
        [{ name: 'Cities', aliases: ['Lyon', 'Marseille'], parents: [] }],
        false,
      ),
    ).toMatchObject({
      created: ['Cities'],
      aliases: [],
      knownAs: [],
      skipped: [
        { kind: 'aliasTaken', tag: 'Cities', alias: 'Lyon', owner: 'Lyon' },
        { kind: 'aliasTaken', tag: 'Cities', alias: 'Marseille', owner: 'Marseille' },
      ],
    });
  });

  it('leaves out an alias that another tag of the library has, and says which', () => {
    const { tags, addTag } = createCheckedLibrary();
    addTag('Paris');
    addTag('Lyon');

    expect(
      tags.applyDefinitions([{ name: 'Paris', aliases: ['lyon', 'Paname'], parents: [] }], false),
    ).toMatchObject({
      aliases: [{ tag: 'Paris', alias: 'Paname' }],
      skipped: [{ kind: 'aliasTaken', tag: 'Paris', alias: 'lyon', owner: 'Lyon' }],
    });
  });

  it('makes one tag of definitions whose names are one, the first keeping a name two give', () => {
    const { tags } = createCheckedLibrary();

    const applied = tags.applyDefinitions(
      [
        { name: 'Paris', aliases: ['Paname'], parents: [] },
        { name: 'PANAME', aliases: ['Lutèce'], parents: ['France'] },
        { name: 'Lyon', aliases: ['paris'], parents: [] },
      ],
      false,
    );

    expect(applied).toMatchObject({
      created: ['Paris', 'Lyon', 'France'],
      aliases: [
        { tag: 'Paris', alias: 'Paname' },
        { tag: 'Paris', alias: 'Lutèce' },
      ],
      links: [{ tag: 'Paris', parent: 'France' }],
      skipped: [{ kind: 'aliasTaken', tag: 'Lyon', alias: 'paris', owner: 'Paris' }],
    });
    expect(applied.named.get('paris')).toBe(idOf(tags, 'Paris'));
  });

  it('passes over a name that cannot be one, and a parent named twice', () => {
    const { tags } = createCheckedLibrary();

    expect(
      tags.applyDefinitions(
        [
          { name: 'Paris, France', aliases: [], parents: [] },
          { name: ' Paris ', aliases: ['', 'a,b', '=x'], parents: ['France', 'FRANCE', '"'] },
        ],
        false,
      ),
    ).toMatchObject({
      created: ['Paris', 'France'],
      aliases: [],
      links: [{ tag: 'Paris', parent: 'France' }],
      skipped: [],
    });
  });

  it('leaves out every new link that would close a loop, and only those', () => {
    const { tags, addTag } = createCheckedLibrary();
    addTag('Paris', { parents: ['France'] });

    const applied = tags.applyDefinitions(
      [
        // Through a link of the library.
        { name: 'France', aliases: [], parents: ['Paris'] },
        // A loop of new links, and a link into it from outside.
        { name: 'X', aliases: [], parents: ['Y'] },
        { name: 'Y', aliases: [], parents: ['Z'] },
        { name: 'Z', aliases: [], parents: ['X'] },
        { name: 'W', aliases: [], parents: ['X'] },
        // The tag itself.
        { name: 'Q', aliases: [], parents: ['q'] },
      ],
      false,
    );

    expect(applied.links).toEqual([expect.objectContaining({ tag: 'W', parent: 'X' })]);
    expect(applied.skipped).toEqual([
      { kind: 'loop', tag: 'Q', parent: 'Q' },
      { kind: 'loop', tag: 'France', parent: 'Paris' },
      { kind: 'loop', tag: 'X', parent: 'Y' },
      { kind: 'loop', tag: 'Y', parent: 'Z' },
      { kind: 'loop', tag: 'Z', parent: 'X' },
    ]);
    expect(describedTags(tags)).toEqual([
      { name: 'France', aliases: [], parents: [] },
      { name: 'Paris', aliases: [], parents: ['France'] },
      { name: 'Q', aliases: [], parents: [] },
      { name: 'W', aliases: [], parents: ['X'] },
      { name: 'X', aliases: [], parents: [] },
      { name: 'Y', aliases: [], parents: [] },
      { name: 'Z', aliases: [], parents: [] },
    ]);
  });

  it('adds a chain of thousands of links listed from the bottom in one pass', () => {
    const { tags } = createTestLibrary();
    const count = 8_000;
    const definitions = Array.from({ length: count }, (_, index) => ({
      name: `t${index}`,
      aliases: [],
      parents: index + 1 < count ? [`t${index + 1}`] : [],
    }));

    const started = performance.now();
    const applied = tags.applyDefinitions(definitions, false);
    const elapsed = performance.now() - started;

    expect(applied.links).toHaveLength(count - 1);
    expect(applied.skipped).toEqual([]);
    // Checking each link against those added before it took 30 s.
    expect(elapsed).toBeLessThan(5_000);
    // And a link from the top back to the bottom closes a loop through all of them.
    expect(
      tags.applyDefinitions([{ name: `t${count - 1}`, aliases: [], parents: ['t0'] }], true)
        .skipped,
    ).toEqual([{ kind: 'loop', tag: `t${count - 1}`, parent: 't0' }]);
  });

  it('stops at the limits on aliases and parent tags, and makes no parent left out', () => {
    const { tags, addTag } = createCheckedLibrary();
    const aliases = Array.from({ length: MAX_TAG_ALIASES - 1 }, (_, index) => `a${index}`);
    const parents = Array.from({ length: MAX_TAG_PARENTS - 1 }, (_, index) => `p${index}`);
    addTag('Full', { aliases, parents });

    const applied = tags.applyDefinitions(
      [{ name: 'Full', aliases: ['one more', 'too many'], parents: ['Last', 'Past'] }],
      false,
    );

    expect(applied).toMatchObject({
      created: ['Last'],
      aliases: [{ tag: 'Full', alias: 'one more' }],
      links: [{ tag: 'Full', parent: 'Last' }],
      skipped: [
        { kind: 'aliasLimit', tag: 'Full', alias: 'too many' },
        { kind: 'parentLimit', tag: 'Full', parent: 'Past' },
      ],
    });
    expect(tags.resolve(['Past'])).toEqual([null]);
  });

  it('keeps the tags it describes, and those it puts above another', () => {
    const { tags, addFile } = createCheckedLibrary();
    const photo = addFile('photo.jpg');
    tags.addToFiles([photo], ['Paris', 'France', 'Lyon']);

    tags.applyDefinitions([{ name: 'Paris', aliases: [], parents: ['France'] }], false);
    tags.removeFromFiles(
      [photo],
      tags.forFile(photo).map((tag) => tag.id),
    );

    // Lyon was made by tagging only: it went with its last file.
    expect(tags.list().map((tag) => tag.name)).toEqual(['France', 'Paris']);
  });

  it('reads every tag made or edited on purpose, with its aliases and parent tags', () => {
    const { tags, addTag, addFile } = createCheckedLibrary();
    addTag('Paris', { aliases: ['Paname', 'Lutèce'], parents: ['France', 'Europe'] });
    addTag('Unused');
    tags.addToFiles([addFile('photo.jpg')], ['t', 'Paris']);

    // Not t, made by tagging a file: a tags export writes it with its file.
    expect(tags.definitions()).toEqual([
      { name: 'Europe', aliases: [], parents: [] },
      { name: 'France', aliases: [], parents: [] },
      { name: 'Paris', aliases: ['Lutèce', 'Paname'], parents: ['Europe', 'France'] },
      { name: 'Unused', aliases: [], parents: [] },
    ]);
  });

  it('describes in another library the tags as they are in this one', () => {
    const random = seededRandom(20_261_115);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const { tags } = createCheckedLibrary();
    const names = Array.from({ length: 40 }, (_, index) => `Tag ${index}`);
    for (let step = 0; step < 300; step++) {
      const name = pick(names);
      const id = tags.resolve([name])[0]?.id ?? editedTag(tags.createTag(name)).id;
      const roll = random();
      if (roll < 0.4) {
        tags.addAlias(id, `${pick(names)} alias ${step % 7}`);
      } else if (roll < 0.9) {
        tags.addParent(id, pick(names));
      } else {
        tags.renameTag(id, `${pick(names)} renamed`, random() < 0.5);
      }
    }
    const other = createCheckedLibrary();

    const applied = other.tags.applyDefinitions(tags.definitions(), false);

    expect(applied.skipped).toEqual([]);
    expect(other.tags.definitions()).toEqual(tags.definitions());
    // And again, it adds nothing.
    expect(other.tags.applyDefinitions(tags.definitions(), false)).toMatchObject({
      created: [],
      aliases: [],
      links: [],
    });
  });

  it('counts the files a search for a parent tag starts to find through a tag put below it', () => {
    const { tags, addTag, addFile } = createCheckedLibrary();
    addTag('Paris');
    addTag('Montmartre', { parents: ['Paris'] });
    addTag('France');
    const [a, b, c, gone] = [
      addFile('a.jpg'),
      addFile('b.jpg'),
      addFile('c.jpg'),
      addFile('gone.jpg', { missingSince: 1 }),
    ];
    tags.addToFiles([a, gone], ['Paris']);
    tags.addToFiles([b], ['Montmartre']);
    tags.addToFiles([b, c], ['France']);
    const paris = idOf(tags, 'Paris');
    const france = idOf(tags, 'France');

    // a, and b through Montmartre, which France finds already; not the missing file.
    expect(tags.newlyFound(paris, france)).toBe(1);
    expect(tags.newlyFound(paris, null)).toBe(2);
    editedTag(tags.addParent(paris, 'France'));
    expect(tags.newlyFound(paris, france)).toBe(0);
  });
});

describe('TagsRepository.addChild', () => {
  it('puts a tag below another by its name or an alias, making it when no tag has the name', () => {
    const { tags, addTag } = createCheckedLibrary();
    const france = addTag('France');
    addTag('Paris', { aliases: ['Paname'] });

    expect(editedTag(tags.addChild(france, 'paname'))).toMatchObject({ name: 'France' });
    expect(editedTag(tags.addChild(france, 'Lyon'))).toMatchObject({ name: 'France' });
    expect(tags.details(france)?.children.map((tag) => tag.name)).toEqual(['Lyon', 'Paris']);
    expect(tags.childCount(france)).toBe(2);
    // Made on purpose: it stays without a file.
    expect(tags.cleanup()).toBe(0);
    // Already below it: nothing changes.
    expect(editedTag(tags.addChild(france, 'Paris'))).toMatchObject({ name: 'France' });
    expect(tags.childCount(france)).toBe(2);
  });

  it('refuses the tag itself, a tag above it, and a name that cannot be one', () => {
    const { tags, addTag } = createCheckedLibrary();
    const paris = addTag('Paris', { parents: ['France'] });
    const france = idOf(tags, 'France');

    expect(errorOf(tags.addChild(france, 'FRANCE'))).toMatchObject({ kind: 'loop' });
    expect(errorOf(tags.addChild(paris, 'France'))).toMatchObject({ kind: 'loop' });
    expect(errorOf(tags.addChild(france, 'a,b'))).toEqual({ kind: 'invalid', problem: 'comma' });
    expect(errorOf(tags.addChild(9_999, 'Lyon'))).toEqual({ kind: 'gone' });
    expect(tags.resolve(['Lyon'])).toEqual([null]);
  });
});

describe('TagsRepository.mergePreview', () => {
  it('counts the files that would gain the tag kept and those that have both, writing nothing', () => {
    const { tags, addFile, db } = createCheckedLibrary();
    const [a, b, gone] = [
      addFile('a.jpg'),
      addFile('b.jpg'),
      addFile('gone.jpg', { missingSince: 1 }),
    ];
    tags.addToFiles([a, b, gone], ['Paname']);
    tags.addToFiles([b], ['Paris']);
    const before = storedRows(db);

    expect(tags.mergePreview(idOf(tags, 'Paname'), idOf(tags, 'Paris'))).toEqual({
      from: { id: idOf(tags, 'Paname'), name: 'Paname' },
      into: { id: idOf(tags, 'Paris'), name: 'Paris' },
      // Missing files are counted: they carry the tag all the same.
      filesMoved: 2,
      filesWithBoth: 1,
      refusal: null,
    });
    expect(storedRows(db)).toEqual(before);
  });

  it('says why a merge would be refused, as the merge would', () => {
    const { tags, addTag } = createCheckedLibrary();
    addTag('Paris', { parents: ['France'] });
    addTag('France', { parents: ['Europe'] });
    const [paris, europe] = [idOf(tags, 'Paris'), idOf(tags, 'Europe')];

    const preview = tags.mergePreview(paris, europe);
    expect(preview?.refusal).toMatchObject({ kind: 'loop' });
    expect(errorOf(tags.mergeTags(paris, europe))).toEqual(preview?.refusal);
    // The same tag twice, or a tag gone: nothing to preview.
    expect(tags.mergePreview(paris, paris)).toBeNull();
    expect(tags.mergePreview(paris, 9_999)).toBeNull();
  });
});
