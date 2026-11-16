import { beforeEach, describe, expect, it } from 'vitest';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import type { CataloguePlace } from './catalogue-locator';
import { CatalogueLocator } from './catalogue-locator';

describe('CatalogueLocator', () => {
  let library: TestLibrary;

  /** The outcome for a file at `path`, in short: `samePlace 3`, `notFound folder`. */
  const locate = (
    path: string,
    known: Partial<Pick<CataloguePlace, 'size' | 'mtimeMs'>> = {},
    caseInsensitive = true,
  ): string => {
    const locator = new CatalogueLocator({
      files: library.files,
      roots: library.roots.list(),
      caseInsensitive,
      platform: 'linux',
    });
    const outcome = locator.locate({
      segments: path.split('/').filter((segment) => segment !== ''),
      size: known.size ?? null,
      mtimeMs: known.mtimeMs ?? null,
    });
    return outcome.kind === 'notFound'
      ? `notFound ${outcome.reason}`
      : `${outcome.kind} ${String(outcome.target.id)}`;
  };

  beforeEach(() => {
    library = createTestLibrary();
  });

  it('finds a file at its path when its size and date agree, on disk or missing from it', () => {
    const photo = library.addFile('Trips/a.jpg', { size: 10, mtimeMs: 5_000 });
    const gone = library.addFile('Trips/b.jpg', { size: 10, mtimeMs: 5_000, missingSince: 1 });

    expect(locate('/library/Trips/a.jpg', { size: 10, mtimeMs: 5_000 })).toBe(
      `samePlace ${String(photo)}`,
    );
    // Dates within 2 s are one, as file systems round them.
    expect(locate('/library/Trips/a.jpg', { size: 10, mtimeMs: 6_999 })).toBe(
      `samePlace ${String(photo)}`,
    );
    expect(locate('/library/Trips/b.jpg', { size: 10, mtimeMs: 5_000 })).toBe(
      `samePlace ${String(gone)}`,
    );
  });

  it('finds a file at its path whatever its size and date when the catalogue gives neither', () => {
    const photo = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });

    expect(locate('/library/a.jpg')).toBe(`samePlace ${String(photo)}`);
    expect(locate('/library/a.jpg', { size: 10 })).toBe(`samePlace ${String(photo)}`);
  });

  it('says a file at its path changed when its size or its date differ', () => {
    const photo = library.addFile('a.jpg', { size: 10, mtimeMs: 5_000 });
    library.addFile('elsewhere/a.jpg', { size: 10, mtimeMs: 9_000 });

    expect(locate('/library/a.jpg', { size: 11, mtimeMs: 5_000 })).toBe(`changed ${String(photo)}`);
    // Not taken for the copy elsewhere that has the date: the file at its place comes first.
    expect(locate('/library/a.jpg', { size: 10, mtimeMs: 9_000 })).toBe(`changed ${String(photo)}`);
  });

  it('finds a moved file by its name, size and date, in any library folder', () => {
    const drive = library.roots.insert('/drive');
    const moved = library.addFile('Sorted/Animals/cat.jpg', { size: 10, mtimeMs: 5_000 });
    const elsewhere = library.addFile('dog.jpg', { root: drive, size: 20, mtimeMs: 6_000 });
    // Another size, or missing from disk: not the file.
    library.addFile('Other/cat.jpg', { size: 11, mtimeMs: 5_000 });
    library.addFile('Gone/cat.jpg', { size: 10, mtimeMs: 5_000, missingSince: 1 });

    expect(locate('/library/Unsorted/cat.jpg', { size: 10, mtimeMs: 5_000 })).toBe(
      `moved ${String(moved)}`,
    );
    expect(locate('/library/Unsorted/DOG.jpg', { size: 20, mtimeMs: 6_000 })).toBe(
      `moved ${String(elsewhere)}`,
    );
  });

  it('finds no moved file without the size and date, or when several have them', () => {
    library.addFile('One/cat.jpg', { size: 10, mtimeMs: 5_000 });
    library.addFile('Two/cat.jpg', { size: 10, mtimeMs: 5_000 });
    library.addFile('Three/dog.jpg', { size: 10, mtimeMs: 5_000 });

    expect(locate('/library/Unsorted/cat.jpg', { size: 10, mtimeMs: 5_000 })).toBe(
      'notFound ambiguous',
    );
    expect(locate('/library/Unsorted/dog.jpg', { size: 10 })).toBe('notFound notFound');
    expect(locate('/library/Unsorted/dog.jpg', { size: 10, mtimeMs: 8_000 })).toBe(
      'notFound notFound',
    );
  });

  it('says a file outside every library folder is so, unless it was moved into one', () => {
    const moved = library.addFile('cat.jpg', { size: 10, mtimeMs: 5_000 });

    expect(locate('/elsewhere/dog.jpg', { size: 10, mtimeMs: 5_000 })).toBe('notFound folder');
    expect(locate('/elsewhere/cat.jpg', { size: 10, mtimeMs: 5_000 })).toBe(
      `moved ${String(moved)}`,
    );
  });

  it('says SG Tag does not index a file of its kind', () => {
    expect(locate('/library/notes.txt')).toBe('notFound notMedia');
    expect(locate('/library/no-extension')).toBe('notFound notMedia');
  });

  it('compares names as this computer does', () => {
    const photo = library.addFile('Trips/a.jpg', { size: 10, mtimeMs: 5_000 });

    expect(locate('/LIBRARY/trips/A.JPG', { size: 10, mtimeMs: 5_000 })).toBe(
      `samePlace ${String(photo)}`,
    );
    expect(locate('/library/Trips/A.JPG', { size: 10, mtimeMs: 5_000 }, false)).toBe(
      'notFound notFound',
    );
  });
});
