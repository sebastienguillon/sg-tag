import { describe, expect, it } from 'vitest';
import { createTestLibrary } from '../testing/test-library';

describe('FilesRepository', () => {
  it('only hands out the paths of videos that are on disk, for streaming', () => {
    const { files, addFile } = createTestLibrary();
    const clip = addFile('trips/clip.mov');
    const photo = addFile('trips/photo.jpg');
    const gone = addFile('trips/gone.mp4');
    files.markMissing(gone, 1);

    expect(files.videoPathOf(clip)).toBe('/library/trips/clip.mov');
    expect(files.videoPathOf(photo)).toBeNull();
    expect(files.videoPathOf(gone)).toBeNull();
    expect(files.videoPathOf(999)).toBeNull();
  });

  it('merges a row into a missing file: first id, second location, tags of both', () => {
    const { files, tags, addFile } = createTestLibrary();
    const original = addFile('a.jpg');
    const copy = addFile('copies/b.jpg');
    tags.addToFiles([original], ['keep']);
    tags.addToFiles([copy], ['new']);
    files.markMissing(original, 1);

    files.transaction(() => {
      files.merge(original, copy);
    });

    expect(files.details(original, new Set())).toMatchObject({
      path: '/library/copies/b.jpg',
      folder: 'copies',
      missing: false,
    });
    expect(files.details(copy, new Set())).toBeNull();
    expect(tags.forFile(original).map((tag) => tag.path)).toEqual(['keep', 'new']);
  });

  it('stores what was read from a file only if the file has not changed since', () => {
    const { files, addFile } = createTestLibrary();
    const id = addFile('a.jpg', { size: 10, mtimeMs: 5 });
    const read = { id, path: '/library/a.jpg', size: 10 };

    files.setFingerprint({ ...read, mtimeMs: 4 }, 'stale');
    expect(files.findByPath('/library/a.jpg')?.fingerprint).toBeNull();
    files.setFingerprint({ ...read, mtimeMs: 5 }, 'fresh');
    expect(files.findByPath('/library/a.jpg')?.fingerprint).toBe('fresh');
  });

  it('lists the other present files with the same content', () => {
    const { files, addFile } = createTestLibrary();
    const add = (path: string, hash: string): number => {
      const id = addFile(path, { size: 10, mtimeMs: 1 });
      files.setContentHash({ id, path, size: 10, mtimeMs: 1 }, hash);
      return id;
    };
    const a = add('a.jpg', 'x');
    const b = add('b/a.jpg', 'x');
    const gone = add('c/a.jpg', 'x');
    add('other.jpg', 'y');
    files.markMissing(gone, 1);

    expect(files.copies(a).map((copy) => copy.id)).toEqual([b]);
    expect(files.contentGroup(b).map((copy) => copy.id)).toEqual(expect.arrayContaining([a, b]));
    expect(files.contentGroup(b)).toHaveLength(2);
    expect(files.countWithCopy()).toBe(2);
  });
});
