import { describe, expect, it } from 'vitest';
import type { ParsedTagFile } from '../tag-transfer/tag-file';
import { createTestLibrary } from '../testing/test-library';
import type { CataloguePlace } from './catalogue-locator';
import { matchCatalogueEntries } from './catalogue-matcher';

/** A catalogue of the files at `paths`, under `folder`, as `catalogueImport` reads it. */
function catalogueOf(
  folder: string,
  places: readonly CataloguePlace[],
): { parsed: ParsedTagFile; places: readonly CataloguePlace[] } {
  return {
    parsed: {
      header: { app: 'media-classification', exportedAt: null, platform: 'linux', roots: [folder] },
      entries: places.map((place) => ({
        root: 0,
        segments: place.segments.slice(1),
        path: `/${place.segments.join('/')}`,
        size: place.size ?? 0,
        mtimeMs: place.mtimeMs,
        fingerprint: null,
        sha256: null,
        missing: false,
        tags: ['Wildlife'],
      })),
      definitions: [],
      tagCount: 1,
      invalid: 0,
      problems: [],
      tags: new Map([['wildlife', 'Wildlife']]),
    },
    places,
  };
}

const at = (path: string, size: number | null = 10, mtimeMs: number | null = 5_000) => ({
  segments: path.split('/').filter((segment) => segment !== ''),
  size,
  mtimeMs,
});

describe('matchCatalogueEntries', () => {
  it('finds each file, says where, and gives a file found for several rows the tags of each', async () => {
    const library = createTestLibrary();
    const a = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });
    const { parsed, places } = catalogueOf('/library', [
      at('/library/a.jpg'),
      // A copy of a, deleted since: the one file of its name, size and date is a.
      at('/library/Old/a.jpg'),
      at('/library/b.jpg'),
    ]);
    const progress: number[] = [];

    const result = await matchCatalogueEntries(parsed, places, {
      files: library.files,
      roots: library.roots.list(),
      caseInsensitive: true,
      signal: new AbortController().signal,
      onProgress: (_step, done) => {
        progress.push(done);
      },
      platform: 'linux',
    });

    expect(
      result.outcomes.map((outcome) =>
        outcome.kind === 'notFound'
          ? `notFound ${outcome.reason}`
          : `${outcome.kind} ${String(outcome.target.id)}${'shared' in outcome && outcome.shared ? ' shared' : ''}`,
      ),
    ).toEqual([`samePlace ${String(a)} shared`, `moved ${String(a)} shared`, 'notFound notFound']);
    expect(result.folders).toEqual([
      {
        exported: '/library',
        files: 3,
        found: 2,
        foundIn: ['/library'],
        inLibrary: true,
        suspicious: false,
      },
    ]);
    expect(result.samePathRoots).toEqual([library.root]);
    expect(result.reads).toBe(0);
    expect(progress.at(-1)).toBe(3);
  });

  it('says nothing of the folder of a catalogue whose rows are all left out', async () => {
    const library = createTestLibrary();
    const { parsed, places } = catalogueOf('', []);

    const result = await matchCatalogueEntries(parsed, places, {
      files: library.files,
      roots: library.roots.list(),
      caseInsensitive: true,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      platform: 'linux',
    });

    expect(result).toEqual({ outcomes: [], folders: [null], samePathRoots: [null], reads: 0 });
  });
});
