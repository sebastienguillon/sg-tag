import { TestBed } from '@angular/core/testing';
import type { Tag } from '@shared/model';
import { FakeWorkerClient, settle } from '../testing/fake-worker-client';
import type { TagSuggestion } from './tags-store';
import { TagsStore } from './tags-store';
import { WorkerClient } from './worker-client';

const tag = (
  id: number,
  name: string,
  fileCount = 1,
  more: Partial<Pick<Tag, 'aliases' | 'parentIds'>> = {},
): Tag => ({
  id,
  name,
  aliases: more.aliases ?? [],
  parentIds: more.parentIds ?? [],
  fileCount,
});

let worker: FakeWorkerClient;

/** The store of a library that holds `tags`, once it listed them. */
const storeOf = async (tags: readonly Tag[]): Promise<TagsStore> => {
  worker.respond('listTags', () => tags);
  const store = TestBed.inject(TagsStore);
  TestBed.tick();
  await settle();
  return store;
};

beforeEach(() => {
  worker = new FakeWorkerClient();
  TestBed.configureTestingModule({ providers: [{ provide: WorkerClient, useValue: worker }] });
});

describe('TagsStore.suggest', () => {
  /** Each suggestion as the tag input shows it: its name, or the alias it matched and its name. */
  const names = (suggestions: readonly TagSuggestion[]): string[] =>
    suggestions.map(({ tag: { name }, alias }) => (alias === null ? name : `${alias} → ${name}`));

  it('ranks the name typed, then names starting with the text, then words starting with it, then the rest', async () => {
    const store = await storeOf([
      tag(1, 'ninja', 50),
      tag(2, 'Trips to Japan', 40),
      tag(3, 'japanese food', 30),
      tag(4, 'Japan', 1),
      tag(5, 'jazz', 20),
    ]);

    expect(names(store.suggest('japan'))).toEqual(['Japan', 'japanese food', 'Trips to Japan']);
    expect(names(store.suggest('ja'))).toEqual([
      'japanese food',
      'jazz',
      'Japan',
      'Trips to Japan',
      'ninja',
    ]);
  });

  it('puts the most used first among names that match as well', async () => {
    const store = await storeOf([
      tag(1, 'beach', 2),
      tag(2, 'beach huts', 9),
      tag(3, 'beaches', 30),
      tag(4, 'the beach', 4),
      tag(5, 'a beach day', 7),
    ]);

    expect(names(store.suggest('beach'))).toEqual([
      'beach',
      'beaches',
      'beach huts',
      'a beach day',
      'the beach',
    ]);
  });

  it('ignores case and accents, as a search by tag does', async () => {
    const store = await storeOf([tag(1, 'Été'), tag(2, 'Égypte'), tag(3, 'Noël')]);

    expect(names(store.suggest('ete'))).toEqual(['Été']);
    expect(names(store.suggest('ÉTÉ'))).toEqual(['Été']);
    // Typed with a combining accent, as some keyboards do.
    expect(names(store.suggest('e\u0301gy'))).toEqual(['Égypte']);
    expect(names(store.suggest('NOEL'))).toEqual(['Noël']);
  });

  it('ignores the characters nobody sees, in what is typed and in the names of tags', async () => {
    // The first as pasted from a web page, with a zero-width space after it.
    const store = await storeOf([
      tag(1, 'Paris\u200B', 2),
      tag(2, 'Parisian', 9),
      tag(3, 'Lyon', 1),
      tag(4, 'New York', 1),
    ]);

    // The name typed, before a name that only starts with it, however used.
    expect(names(store.suggest('paris'))).toEqual(['Paris\u200B', 'Parisian']);
    expect(names(store.suggest('Pa\u00ADris'))).toEqual(['Paris\u200B', 'Parisian']);
    // The other way round: typed with a soft hyphen, direction marks or a zero-width space, and
    // stored without.
    expect(names(store.suggest('Ly\u00ADon'))).toEqual(['Lyon']);
    expect(names(store.suggest('\u200Ely\u200F'))).toEqual(['Lyon']);
    expect(names(store.suggest('yo\u200Bn'))).toEqual(['Lyon']);
    // Nor does a space count for having one beside it: these are no two spaces between the words.
    expect(names(store.suggest('new \u200B york'))).toEqual(['New York']);
  });

  it('suggests nothing while nothing but characters nobody sees is typed', async () => {
    const store = await storeOf([tag(1, 'Paris\u200B'), tag(2, 'jazz')]);

    // A zero-width space, a soft hyphen and a word joiner around a space, a byte order mark:
    // nothing is left of them to compare, which every name would hold.
    expect(store.suggest('\u200B')).toEqual([]);
    expect(store.suggest('\u00AD \u2060')).toEqual([]);
    expect(store.suggest('\uFEFF')).toEqual([]);
  });

  it('puts the name that is the text but for its accents before a name that only starts with it', async () => {
    const store = await storeOf([tag(1, 'Égypte', 1), tag(2, 'Égypte ancienne', 9)]);

    expect(names(store.suggest('egypte'))).toEqual(['Égypte', 'Égypte ancienne']);
  });

  it('puts the tag typed with its accents before one that differs by them, however used', async () => {
    const store = await storeOf([tag(1, 'côte', 90), tag(2, 'côté', 2), tag(3, 'cote', 40)]);

    expect(names(store.suggest('Côté'))).toEqual(['côté', 'côte', 'cote']);
    expect(names(store.suggest('cote'))).toEqual(['cote', 'côte', 'côté']);
  });

  it('finds a word after any punctuation: a slash is a character like another', async () => {
    const store = await storeOf([
      tag(1, 'trips/japan', 1),
      tag(2, 'Paris (Texas)', 1),
      tag(3, 'context', 9),
      tag(4, 'l’été', 1),
    ]);

    expect(names(store.suggest('trips/j'))).toEqual(['trips/japan']);
    expect(names(store.suggest('japan'))).toEqual(['trips/japan']);
    expect(names(store.suggest('tex'))).toEqual(['Paris (Texas)', 'context']);
    expect(names(store.suggest('ete'))).toEqual(['l’été']);
  });

  it('collapses the whitespace typed, as a name does', async () => {
    const store = await storeOf([tag(1, 'New York'), tag(2, 'Newark')]);

    expect(names(store.suggest('  new   york '))).toEqual(['New York']);
  });

  it('leaves out tags by their id', async () => {
    const store = await storeOf([tag(1, 'jazz', 9), tag(2, 'Japan', 5), tag(3, 'java', 1)]);

    expect(names(store.suggest('ja', new Set([1, 3])))).toEqual(['Japan']);
  });

  it('suggests 8 tags at most', async () => {
    const store = await storeOf(
      Array.from({ length: 12 }, (_, index) => tag(index + 1, `trip ${index + 1}`, index)),
    );

    expect(names(store.suggest('trip'))).toEqual([
      'trip 12',
      'trip 11',
      'trip 10',
      'trip 9',
      'trip 8',
      'trip 7',
      'trip 6',
      'trip 5',
    ]);
  });

  it('suggests nothing while nothing but spaces or accents is typed', async () => {
    const store = await storeOf([tag(1, 'Été'), tag(2, 'jazz')]);

    expect(store.suggest('')).toEqual([]);
    expect(store.suggest('  ')).toEqual([]);
    expect(store.suggest('\u0301')).toEqual([]);
  });

  it('suggests nothing for a text longer than a name can be, and does not compose it', async () => {
    const store = await storeOf([tag(1, 'jazz')]);

    // A name holds 1,024 UTF-16 units at most; the spaces after the text count as it is typed.
    expect(names(store.suggest(`jazz${' '.repeat(1_020)}`))).toEqual(['jazz']);
    expect(store.suggest(`jazz${' '.repeat(1_021)}`)).toEqual([]);

    // A pasted run of combining marks: composing it is what takes long, the longer the run.
    const pasted = `a${'\u0301\u0323'.repeat(2_000)}`;
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const suggested = store.suggest(pasted);
    const composed = normalize.mock.calls.length;
    normalize.mockRestore();

    expect(suggested).toEqual([]);
    expect(composed).toBe(0);
  });

  it('suggests the tags as they are after a change', async () => {
    const store = await storeOf([tag(1, 'jazz')]);
    worker.respond('listTags', () => [tag(1, 'jazz'), tag(2, 'Japan', 3)]);
    worker.emit('tagsChanged', null);
    TestBed.tick();
    await settle();

    expect(names(store.suggest('ja'))).toEqual(['Japan', 'jazz']);
  });

  it('matches the aliases of tags as it matches names, and suggests each tag once', async () => {
    const store = await storeOf([
      tag(1, 'Paris', 40, { aliases: ['Paname', 'Lutèce'] }),
      tag(2, 'Parme', 3),
      tag(3, 'Lyon', 9, { aliases: ['Lugdunum'] }),
    ]);

    expect(names(store.suggest('pan'))).toEqual(['Paname → Paris']);
    // Without its accents, as a name.
    expect(names(store.suggest('LUTE'))).toEqual(['Lutèce → Paris']);
    expect(names(store.suggest('lu'))).toEqual(['Lutèce → Paris', 'Lugdunum → Lyon']);
    // Its name matches as well as an alias: the tag comes once, by its name.
    expect(names(store.suggest('pa'))).toEqual(['Paris', 'Parme']);
  });

  it('ranks a tag by the name or alias that matches best', async () => {
    const store = await storeOf([
      tag(1, 'Lutèce', 1, { aliases: ['Paris'] }),
      tag(2, 'Parisian', 50),
      tag(3, 'Champs', 90, { aliases: ['Paris street'] }),
    ]);

    // The alias that is the text comes before a name that starts with it, however used.
    expect(names(store.suggest('paris'))).toEqual([
      'Paris → Lutèce',
      'Paris street → Champs',
      'Parisian',
    ]);
  });

  it('leaves out a tag by its id, whichever of its names matches', async () => {
    const store = await storeOf([tag(1, 'Paris', 4, { aliases: ['Paname'] }), tag(2, 'Panama')]);

    expect(names(store.suggest('pan', new Set([1])))).toEqual(['Panama']);
  });
});

describe('TagsStore.resolve', () => {
  it('finds the tag that a text is the name or an alias of, whatever its letter case', async () => {
    const store = await storeOf([tag(1, 'Paris', 1, { aliases: ['Paname'] }), tag(2, 'Égypte')]);

    expect(store.resolve('paris')?.name).toBe('Paris');
    expect(store.resolve('  PANAME ')?.name).toBe('Paris');
    expect(store.resolve('égypte')?.name).toBe('Égypte');
    expect(store.resolve('Pari')).toBeNull();
    expect(store.resolve('')).toBeNull();
  });

  it('finds the one tag that a text typed without its accents is', async () => {
    const store = await storeOf([tag(1, 'Égypte'), tag(2, 'Noël', 1, { aliases: ['Père Noël'] })]);

    expect(store.resolve('Egypte')?.name).toBe('Égypte');
    expect(store.resolve('pere noel')?.name).toBe('Noël');
  });

  it('finds no tag by a text without accents that two tags are', async () => {
    const store = await storeOf([tag(1, 'côte'), tag(2, 'côté', 1, { aliases: ['coté'] })]);

    expect(store.resolve('cote')).toBeNull();
    // With its accents, the text is one of them.
    expect(store.resolve('Côté')?.name).toBe('côté');
  });

  it('tells whether a text is the name or an alias of a tag, accents counted', async () => {
    const store = await storeOf([tag(1, 'Égypte', 1, { aliases: ['Kemet'] })]);

    expect(store.isName('égypte')).toBe(true);
    expect(store.isName(' KEMET ')).toBe(true);
    expect(store.isName('Egypte')).toBe(false);
    expect(store.isName('Kem')).toBe(false);
  });
});

describe('TagsStore.above and TagsStore.below', () => {
  /** Europe › France › Île-de-France › Paris, and Lyon below France; Paris is a capital too. */
  const LIBRARY = [
    tag(1, 'Capitals'),
    tag(2, 'Europe'),
    tag(3, 'France', 1, { parentIds: [2] }),
    tag(4, 'Île-de-France', 1, { parentIds: [3] }),
    tag(5, 'Lyon', 1, { parentIds: [3] }),
    tag(6, 'Paris', 1, { parentIds: [4, 1] }),
  ];
  const names = (tags: readonly Tag[]): string[] => tags.map((each) => each.name);

  it('lists the tags above a tag, at any depth: nearest first, then by name', async () => {
    const store = await storeOf(LIBRARY);

    expect(names(store.above(6))).toEqual(['Capitals', 'Île-de-France', 'France', 'Europe']);
    expect(store.above(2)).toEqual([]);
  });

  it('lists the tags below a tag, at any depth: nearest first, then by name', async () => {
    const store = await storeOf(LIBRARY);

    expect(names(store.below(2))).toEqual(['France', 'Île-de-France', 'Lyon', 'Paris']);
    expect(names(store.below(1))).toEqual(['Paris']);
    expect(store.below(6)).toEqual([]);
  });

  it('puts tags in the order the worker sorts names, those it did not list last', async () => {
    const store = await storeOf(LIBRARY);

    const refs = [
      { id: 6, name: 'Paris' },
      { id: 99, name: 'Aardvark' },
      { id: 2, name: 'Europe' },
    ];
    expect(store.inNameOrder(refs).map((ref) => ref.name)).toEqual(['Europe', 'Paris', 'Aardvark']);
  });
});
