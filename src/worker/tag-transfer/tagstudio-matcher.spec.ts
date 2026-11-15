import { beforeEach, describe, expect, it } from 'vitest';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import type { ParsedTagFile } from './tag-file';
import type { MatchResult } from './tag-matcher';
import { matchTagStudioEntries } from './tagstudio-matcher';

/** A TagStudio library in `folder` as `readTagStudioLibrary` reads it, its files at `rels`. */
function libraryOf(folder: string, rels: readonly string[]): ParsedTagFile {
  return {
    header: { app: 'TagStudio', exportedAt: null, platform: process.platform, roots: [folder] },
    entries: rels.map((rel) => ({
      root: 0,
      segments: rel.split('/'),
      path: `${folder}/${rel}`,
      size: 0,
      mtimeMs: null,
      fingerprint: null,
      sha256: null,
      missing: false,
      tags: ['Paris'],
    })),
    definitions: [],
    tagCount: 1,
    invalid: 0,
    problems: [],
    tags: new Map([['paris', 'Paris']]),
  };
}

describe('matchTagStudioEntries', () => {
  let library: TestLibrary;

  const match = (
    folder: string,
    rels: readonly string[],
    caseInsensitive = true,
  ): Promise<MatchResult> =>
    matchTagStudioEntries(libraryOf(folder, rels), {
      files: library.files,
      roots: library.roots.list(),
      caseInsensitive,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

  /** Each outcome in short: `samePlace 3`, `moved 4`, `notFound ambiguous`. */
  const outcomesOf = (result: MatchResult): string[] =>
    result.outcomes.map((outcome) => {
      switch (outcome.kind) {
        case 'notFound':
          return `notFound ${outcome.reason}`;
        case 'changed':
          return `changed ${String(outcome.target.id)}`;
        default:
          return `${outcome.kind} ${String(outcome.target.id)}${outcome.shared ? ' shared' : ''}`;
      }
    });

  beforeEach(() => {
    library = createTestLibrary();
  });

  it('finds a file at its path, on disk or missing from it', async () => {
    const photo = library.addFile('Trips/a.jpg');
    const gone = library.addFile('Trips/b.jpg', { missingSince: 1 });

    const result = await match('/library', ['Trips/a.jpg', 'Trips/b.jpg']);

    expect(outcomesOf(result)).toEqual([`samePlace ${String(photo)}`, `samePlace ${String(gone)}`]);
    expect(result.folders).toEqual([
      {
        exported: '/library',
        files: 2,
        found: 2,
        foundIn: ['/library'],
        inLibrary: true,
        suspicious: false,
      },
    ]);
    expect(result.samePathRoots).toEqual([library.root]);
    expect(result.reads).toBe(0);
  });

  it('compares names as this computer does', async () => {
    const photo = library.addFile('Trips/a.jpg');

    expect(outcomesOf(await match('/library', ['trips/A.JPG']))).toEqual([
      `samePlace ${String(photo)}`,
    ]);
    // Where case tells files apart, it is another file, which is not there.
    expect(outcomesOf(await match('/library', ['trips/A.JPG'], false))).toEqual([
      'notFound notFound',
    ]);
  });

  it('finds a moved file by its name, as TagStudio relinks it', async () => {
    const moved = library.addFile('New/b.jpg');
    // Not on disk: not taken by name.
    library.addFile('Gone/c.jpg', { missingSince: 1 });

    const result = await match('/library', ['Old/b.jpg', 'Old/c.jpg']);

    expect(outcomesOf(result)).toEqual([`moved ${String(moved)}`, 'notFound notFound']);
    expect(result.folders[0]).toMatchObject({ files: 2, found: 1 });
  });

  it('takes only files below the library’s folder by name', async () => {
    library.addFile('Elsewhere/b.jpg');
    const inside = library.addFile('Photos/New/c.jpg');

    expect(outcomesOf(await match('/library/Photos', ['Old/b.jpg', 'Old/c.jpg']))).toEqual([
      'notFound notFound',
      `moved ${String(inside)}`,
    ]);
  });

  it('finds no file by a name several files have', async () => {
    library.addFile('One/b.jpg');
    library.addFile('Two/b.jpg');

    expect(outcomesOf(await match('/library', ['Old/b.jpg']))).toEqual(['notFound ambiguous']);
  });

  it('gives a file the tags of each entry that is it, as TagStudio merges them', async () => {
    const file = library.addFile('New/b.jpg');

    // The file at its new place, and the entry left at its old one.
    expect(outcomesOf(await match('/library', ['New/b.jpg', 'Old/b.jpg', 'Older/b.jpg']))).toEqual([
      `samePlace ${String(file)}`,
      `moved ${String(file)}`,
      `moved ${String(file)}`,
    ]);
    // Two names this computer takes as one, at one place.
    expect(outcomesOf(await match('/library', ['New/b.jpg', 'New/B.jpg']))).toEqual([
      `samePlace ${String(file)} shared`,
      `samePlace ${String(file)} shared`,
    ]);
  });

  it('says which files SG Tag does not index', async () => {
    library.addFile('notes.txt');

    expect(outcomesOf(await match('/library', ['notes.txt', 'shortcut.lnk']))).toEqual([
      'notFound notMedia',
      'notFound notMedia',
    ]);
  });

  it('says which files are outside the library folders, unless moved into one', async () => {
    const sub = library.roots.insert('/data/sub');
    const moved = library.addFile('x.jpg', { root: sub });

    const result = await match('/data', ['x.jpg', 'y.jpg', 'sub/z.jpg']);

    expect(outcomesOf(result)).toEqual([
      `moved ${String(moved)}`,
      'notFound folder',
      'notFound notFound',
    ]);
    expect(result.folders[0]).toMatchObject({
      exported: '/data',
      found: 1,
      foundIn: ['/data/sub'],
      inLibrary: false,
    });
    expect(result.samePathRoots).toEqual([null]);
  });

  it('finds the files of a library inside a library folder', async () => {
    const photo = library.addFile('Photos/Trips/a.jpg');

    const result = await match('/library/Photos', ['Trips/a.jpg']);

    expect(outcomesOf(result)).toEqual([`samePlace ${String(photo)}`]);
    expect(result.folders[0]).toMatchObject({ foundIn: ['/library'], inLibrary: false });
  });

  it('lists no folder for a library without tagged files', async () => {
    const result = await match('/library', []);

    expect(result.outcomes).toEqual([]);
    expect(result.folders).toEqual([null]);
  });
});
