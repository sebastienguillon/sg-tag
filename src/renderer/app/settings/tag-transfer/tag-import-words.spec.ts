import type { ImportCounts } from './tag-import-words';
import { importAdditions } from './tag-import-words';

const nothing: ImportCounts = { assignments: 0, files: 0, newTags: 0, aliases: 0, links: 0 };

describe('importAdditions', () => {
  const adds = (counts: Partial<ImportCounts>): string =>
    importAdditions({ ...nothing, ...counts }, 'present', 'en-US');

  it('says each part that is there, with a comma before the last of two or more', () => {
    expect(adds({ assignments: 3_410, files: 2_980 })).toBe('adds 3,410 tags to 2,980 files');
    expect(adds({ assignments: 3_410, files: 2_980, newTags: 9 })).toBe(
      'adds 3,410 tags to 2,980 files, and creates 9 new tags',
    );
    expect(adds({ assignments: 1, files: 1, newTags: 1, aliases: 1, links: 1 })).toBe(
      'adds 1 tag to 1 file, creates 1 new tag, and adds 1 alias and 1 parent tag',
    );
    expect(adds({ newTags: 4, links: 2 })).toBe('creates 4 new tags, and adds 2 parent tags');
    expect(adds({ aliases: 2 })).toBe('adds 2 aliases');
    expect(adds({})).toBe('');
  });

  it('says what an import added', () => {
    expect(
      importAdditions({ ...nothing, assignments: 2, files: 1, aliases: 3 }, 'past', 'en-US'),
    ).toBe('added 2 tags to 1 file, and added 3 aliases');
    expect(importAdditions({ ...nothing, newTags: 1 }, 'past', 'en-US')).toBe('created 1 new tag');
  });
});
