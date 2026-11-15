import type { CatalogueFilters } from '@shared/model';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import type { Catalogue, CatalogueRow } from './catalogue-file';
import { catalogueImport, UNCLEAR_CATEGORY } from './catalogue-import';

const NONE: CatalogueFilters = { lowConfidence: false, flagged: false, unclear: false };

/** A row for the file at `path`, of an animal photo by default. */
function row(path: string, fields: Partial<CatalogueRow> = {}): CatalogueRow {
  return {
    row: 2,
    path,
    segments: path.split('/').filter((segment) => segment !== ''),
    size: 10,
    mtimeMs: 5_000,
    category: 'Animals',
    subcategory: 'Wildlife',
    formats: [],
    confidence: 'high',
    flagged: false,
    reviewStatus: null,
    topic: null,
    visibleContent: null,
    reviewNotes: null,
    ...fields,
  };
}

function catalogueOf(rows: readonly CatalogueRow[]): Catalogue {
  return {
    path: '/reports/media_catalog.csv',
    size: 100,
    mtimeMs: Date.UTC(2026, 9, 18),
    rows,
    invalid: 1,
    problems: ['Row 9: no source path.'],
    renamed: 2,
    leftOut: 0,
  };
}

describe('catalogueImport', () => {
  let library: TestLibrary;

  beforeEach(() => {
    library = createTestLibrary();
  });

  it('gives each file its subcategory, below its category, in the deepest folder of all', () => {
    const { parsed, places } = catalogueImport(
      catalogueOf([
        row('/media/2026/a.jpg'),
        row('/media/2026/trips/b.jpg', { category: 'Sports', subcategory: 'Fitness' }),
        row('/media/2026/c.jpg', { size: null, mtimeMs: null }),
      ]),
      NONE,
      library.tags,
      'linux',
    );

    expect(parsed.header).toEqual({
      app: 'media-classification',
      exportedAt: '2026-10-18T00:00:00.000Z',
      platform: 'linux',
      roots: ['/media/2026'],
    });
    expect(
      parsed.entries.map(({ segments, path, size, mtimeMs, tags }) => [
        segments,
        path,
        size,
        mtimeMs,
        tags,
      ]),
    ).toEqual([
      [['a.jpg'], '/media/2026/a.jpg', 10, 5_000, ['Wildlife']],
      [['trips', 'b.jpg'], '/media/2026/trips/b.jpg', 10, 5_000, ['Fitness']],
      [['c.jpg'], '/media/2026/c.jpg', 0, null, ['Wildlife']],
    ]);
    expect(places.map(({ size, mtimeMs }) => [size, mtimeMs])).toEqual([
      [10, 5_000],
      [10, 5_000],
      [null, null],
    ]);
    expect(parsed.definitions).toEqual([
      { name: 'Animals', aliases: [], parents: [] },
      { name: 'Sports', aliases: [], parents: [] },
      { name: 'Wildlife', aliases: [], parents: ['Animals'] },
      { name: 'Fitness', aliases: [], parents: ['Sports'] },
    ]);
    expect(parsed.tagCount).toBe(4);
    expect(parsed.invalid).toBe(1);
    expect(parsed.problems).toEqual(['Row 9: no source path.']);
  });

  it('leaves out rows of low confidence, flagged, or of unclear subject, unless included', () => {
    const catalogue = catalogueOf([
      row('/media/a.jpg'),
      row('/media/b.jpg', { confidence: 'Low' }),
      row('/media/c.jpg', { flagged: true }),
      row('/media/d.jpg', { flagged: true, confidence: 'low' }),
      row('/media/e.jpg', { category: UNCLEAR_CATEGORY, subcategory: 'Unclear' }),
    ]);
    const kept = (filters: CatalogueFilters): string[] =>
      catalogueImport(catalogue, filters, library.tags, 'linux').parsed.entries.map(
        (entry) => entry.path ?? '',
      );

    expect(kept(NONE)).toEqual(['/media/a.jpg']);
    expect(kept({ ...NONE, lowConfidence: true })).toEqual(['/media/a.jpg', '/media/b.jpg']);
    expect(kept({ ...NONE, flagged: true, lowConfidence: true })).toEqual([
      '/media/a.jpg',
      '/media/b.jpg',
      '/media/c.jpg',
      '/media/d.jpg',
    ]);
    expect(kept({ ...NONE, unclear: true })).toEqual(['/media/a.jpg', '/media/e.jpg']);

    const { details } = catalogueImport(catalogue, NONE, library.tags, 'linux');
    expect(details).toMatchObject({
      filters: NONE,
      rows: 5,
      matching: { lowConfidence: 2, flagged: 2, unclear: 1 },
      leftOut: 4,
      renamed: 2,
    });
  });

  it('gives files only the format tags a tag has, or that the import makes, and lists the others', () => {
    library.addTag('Selfies', { aliases: ['selfie'] });
    library.addTag('Crowd');
    const { parsed, formats, details } = catalogueImport(
      catalogueOf([
        row('/media/a.jpg', { formats: ['selfie', 'phone video', 'crowd'] }),
        row('/media/b.jpg', { formats: ['phone video', 'Fitness', 'subtitles'] }),
        row('/media/c.jpg', { category: 'Sports', subcategory: 'Fitness', formats: ['night'] }),
      ]),
      NONE,
      library.tags,
      'linux',
    );

    expect(parsed.entries.map((entry) => entry.tags)).toEqual([
      ['Wildlife', 'selfie', 'crowd'],
      ['Wildlife', 'Fitness'],
      ['Fitness'],
    ]);
    expect([...formats].sort()).toEqual(['crowd', 'selfie']);
    expect(details).toMatchObject({
      formatsWithoutTag: 3,
      filesWithoutFormat: 3,
      formatItems: [
        { name: 'phone video', files: 2 },
        { name: 'night', files: 1 },
        { name: 'subtitles', files: 1 },
      ],
    });
    // Each name of a tag once, as the tags export writes it first.
    expect([...parsed.tags]).toEqual([
      ['wildlife', 'Wildlife'],
      ['selfie', 'selfie'],
      ['crowd', 'crowd'],
      ['fitness', 'Fitness'],
    ]);
  });

  it('writes the folder of Windows paths as Windows does, and none when no row is kept', () => {
    const windows = (rows: readonly CatalogueRow[]) =>
      catalogueImport(catalogueOf(rows), NONE, library.tags, 'win32').parsed.header.roots;
    const at = (...segments: string[]) => row('', { path: segments.join('\\'), segments });

    expect(windows([at('D:', 'Drama', 'a.jpg'), at('D:', 'Drama', 'x', 'b.jpg')])).toEqual([
      'D:\\Drama',
    ]);
    expect(windows([at('D:', 'a.jpg'), at('D:', 'x', 'b.jpg')])).toEqual(['D:\\']);
    expect(windows([at('nas', 'media', 'a.jpg')])).toEqual(['\\\\nas\\media']);
    expect(windows([])).toEqual(['']);
  });
});
