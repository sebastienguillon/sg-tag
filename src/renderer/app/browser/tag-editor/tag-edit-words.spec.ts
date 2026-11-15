import type { TagDetails, TagMergePreview, TagRef } from '@shared/model';
import {
  deleteQuestion,
  describeDeleteError,
  describeTagEditError,
  mergeQuestion,
  nameList,
} from './tag-edit-words';

const ref = (id: number, name: string): TagRef => ({ id, name });
const PARIS = ref(1, 'Paris');
const FRANCE = ref(2, 'France');
const EUROPE = ref(3, 'Europe');
const ILE_DE_FRANCE = ref(4, 'Île-de-France');

const details = (more: Partial<TagDetails> = {}): TagDetails => ({
  tag: { ...PARIS, aliases: [], parentIds: [], fileCount: 0 },
  parents: [],
  children: [],
  tagsBelow: 0,
  ownFiles: 0,
  filesWithBelow: 0,
  taggedFiles: 0,
  forgottenFiles: 0,
  ...more,
});

describe('nameList', () => {
  it('joins names as a sentence does, and counts those past the fifth', () => {
    expect(nameList([], 'en')).toBe('');
    expect(nameList(['A'], 'en')).toBe('A');
    expect(nameList(['A', 'B'], 'en')).toBe('A and B');
    expect(nameList(['A', 'B', 'C', 'D', 'E'], 'en')).toBe('A, B, C, D and E');
    expect(nameList(['A', 'B', 'C', 'D', 'E', 'F'], 'en')).toBe('A, B, C, D and 2 others');
  });
});

describe('describeTagEditError', () => {
  it('says each refusal in words', () => {
    expect(describeTagEditError({ kind: 'gone' }, null, 'en')).toBe('This tag no longer exists.');
    expect(describeTagEditError({ kind: 'busy' }, null, 'en')).toBe(
      'Tags are being exported or imported: try again once that is done.',
    );
    expect(describeTagEditError({ kind: 'invalid', problem: 'equals' }, null, 'en')).toBe(
      'A tag cannot start with “=”.',
    );
    expect(describeTagEditError({ kind: 'limit', what: 'aliases' }, null, 'en')).toBe(
      'A tag cannot have more than 100 aliases.',
    );
    expect(describeTagEditError({ kind: 'limit', what: 'parents' }, null, 'en')).toBe(
      'A tag cannot have more than 100 parent tags.',
    );
  });

  it('quotes the name typed that another tag has, and names that tag', () => {
    const owner = ref(5, 'Lyon');
    expect(describeTagEditError({ kind: 'taken', owner, asAlias: false }, 'lyon', 'en')).toBe(
      '“lyon” is already the name of the tag Lyon.',
    );
    expect(describeTagEditError({ kind: 'taken', owner, asAlias: true }, 'Lugdunum', 'en')).toBe(
      '“Lugdunum” is already an alias of the tag Lyon.',
    );
    // A long name, as pasted, is quoted by its start.
    expect(
      describeTagEditError({ kind: 'taken', owner, asAlias: true }, 'x'.repeat(100), 'en'),
    ).toBe(`“${'x'.repeat(60)}…” is already an alias of the tag Lyon.`);
  });

  it('says from the tag below which tag is above it, and through which', () => {
    expect(
      describeTagEditError(
        { kind: 'loop', above: PARIS, below: FRANCE, through: ILE_DE_FRANCE },
        null,
        'en',
      ),
    ).toBe('France is below Paris, through Île-de-France.');
    expect(
      describeTagEditError(
        { kind: 'loop', above: PARIS, below: FRANCE, through: null },
        null,
        'en',
      ),
    ).toBe('France is below Paris.');
    expect(
      describeTagEditError({ kind: 'loop', above: PARIS, below: PARIS, through: null }, null, 'en'),
    ).toBe('A tag cannot be below itself.');
  });
});

describe('describeDeleteError', () => {
  it('says that a limit is that of a child tag', () => {
    expect(describeDeleteError({ kind: 'limit', what: 'parents' }, 'en')).toBe(
      'This tag cannot be deleted: one of its child tags would then have more than 100 parent tags.',
    );
    expect(describeDeleteError({ kind: 'busy' }, 'en')).toBe(
      'Tags are being exported or imported: try again once that is done.',
    );
  });
});

describe('deleteQuestion', () => {
  it('says how many files lose the tag, and how many of them are forgotten', () => {
    expect(deleteQuestion(details(), 'en')).toBe(
      'Delete the tag “Paris”? No file has it. This cannot be undone.',
    );
    expect(deleteQuestion(details({ taggedFiles: 1_200 }), 'en')).toBe(
      'Delete the tag “Paris”? 1,200 files lose it. This cannot be undone.',
    );
    expect(deleteQuestion(details({ taggedFiles: 3, forgottenFiles: 1 }), 'en')).toBe(
      'Delete the tag “Paris”? 3 files lose it; 1 of them is missing from disk and will be forgotten. This cannot be undone.',
    );
    expect(deleteQuestion(details({ taggedFiles: 1, forgottenFiles: 1 }), 'en')).toBe(
      'Delete the tag “Paris”? 1 file loses it; it is missing from disk and will be forgotten. This cannot be undone.',
    );
    expect(deleteQuestion(details({ taggedFiles: 2, forgottenFiles: 2 }), 'en')).toBe(
      'Delete the tag “Paris”? 2 files lose it; they are all missing from disk and will be forgotten. This cannot be undone.',
    );
  });

  it('says that its aliases go', () => {
    const tag = details().tag;
    expect(deleteQuestion(details({ tag: { ...tag, aliases: ['Paname', 'Lutèce'] } }), 'en')).toBe(
      'Delete the tag “Paris”? No file has it. Its aliases Paname and Lutèce go too. This cannot be undone.',
    );
  });

  it('says where its child tags go: up to its parent tags, which still find their files', () => {
    const children = [ref(10, 'Belleville'), ref(11, 'Montmartre')];
    expect(deleteQuestion(details({ children, parents: [ILE_DE_FRANCE, EUROPE] }), 'en')).toBe(
      'Delete the tag “Paris”? No file has it. Its child tags Belleville and Montmartre move up to Île-de-France and Europe, so that Île-de-France and Europe still find their files. This cannot be undone.',
    );
    expect(deleteQuestion(details({ children }), 'en')).toBe(
      'Delete the tag “Paris”? No file has it. Its child tags Belleville and Montmartre become tags without a parent. This cannot be undone.',
    );
    expect(deleteQuestion(details({ children: children.slice(1) }), 'en')).toBe(
      'Delete the tag “Paris”? No file has it. Its child tag Montmartre becomes a tag without a parent. This cannot be undone.',
    );
  });
});

describe('mergeQuestion', () => {
  const preview = (more: Partial<TagMergePreview> = {}): TagMergePreview => ({
    from: ref(5, 'Paname'),
    into: PARIS,
    filesMoved: 12,
    filesWithBoth: 3,
    refusal: null,
    ...more,
  });

  it('says which files gain the tag kept, and what becomes of the other one', () => {
    expect(mergeQuestion(preview(), { aliases: 2, parents: 1, children: 1 }, 'en')).toBe(
      'Merge “Paname” into “Paris”? 12 files gain Paris (3 had both). Paname and its aliases become aliases of Paris, and its parent and child tags become those of Paris. This cannot be undone.',
    );
    expect(
      mergeQuestion(
        preview({ filesMoved: 0, filesWithBoth: 0 }),
        { aliases: 0, parents: 0, children: 0 },
        'en',
      ),
    ).toBe(
      'Merge “Paname” into “Paris”? No file gains Paris. Paname becomes an alias of Paris. This cannot be undone.',
    );
    expect(
      mergeQuestion(
        preview({ filesMoved: 1, filesWithBoth: 0 }),
        { aliases: 0, parents: 0, children: 4 },
        'en',
      ),
    ).toBe(
      'Merge “Paname” into “Paris”? 1 file gains Paris. Paname becomes an alias of Paris, and its child tags become those of Paris. This cannot be undone.',
    );
  });

  it('says why the merge would be refused, and asks nothing', () => {
    expect(
      mergeQuestion(
        preview({ refusal: { kind: 'limit', what: 'aliases' } }),
        { aliases: 0, parents: 0, children: 0 },
        'en',
      ),
    ).toBe('Paname cannot be merged into Paris. A tag cannot have more than 100 aliases.');
  });
});
