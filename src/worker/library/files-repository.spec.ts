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

  it('does not take one file seen through two paths (a link) for a copy of itself', () => {
    const { files, addFile } = createTestLibrary();
    const add = (path: string, fileId: string): number => {
      const id = addFile(path, { size: 10, mtimeMs: 1, fileId });
      files.setContentHash({ id, path, size: 10, mtimeMs: 1 }, 'x');
      return id;
    };
    const photo = add('photo.jpg', '1:7');
    const link = add('favourites/photo.jpg', '1:7');

    expect(files.copies(photo)).toEqual([]);
    expect(files.countWithCopy()).toBe(0);

    const copy = add('backup/photo.jpg', '2:7');
    expect(files.copies(photo).map((other) => other.id)).toEqual([copy]);
    expect(files.copies(copy).map((other) => other.id)).toEqual([link, photo]);
    expect(files.countWithCopy()).toBe(3);
  });

  it('keeps what was read from a file only while it is the same file', () => {
    const { db, files, addFile } = createTestLibrary();
    const hashOf = (id: number): unknown =>
      db.prepare('SELECT content_hash FROM files WHERE id = ?').pluck().get(id);
    const printOf = (id: number): unknown =>
      db.prepare('SELECT fingerprint FROM files WHERE id = ?').pluck().get(id);
    const add = (path: string, fileId: string): number => {
      const id = addFile(path, { size: 10, mtimeMs: 1, fileId });
      files.setFingerprint({ id, path, size: 10, mtimeMs: 1 }, `print of ${path}`);
      files.setContentHash({ id, path, size: 10, mtimeMs: 1 }, `hash of ${path}`);
      return id;
    };
    const record = (path: string, fileId: string) => ({
      rootId: 1,
      path: `/library/${path}`,
      dir: '',
      name: path,
      ext: 'jpg',
      kind: 'image' as const,
      size: 10,
      mtimeMs: 1,
      birthtimeMs: null,
      fileId,
    });

    // Renamed on the same volume: same inode, the hash still holds.
    const renamed = add('a.jpg', '1:1');
    files.markMissing(renamed, 1);
    files.relocate(renamed, record('renamed.jpg', '1:1'));
    expect(hashOf(renamed)).toBe('hash of a.jpg');

    // Matched by fingerprint only: the middle of the content may differ.
    const copied = add('b.jpg', '1:2');
    files.markMissing(copied, 1);
    const later = Date.now() + 60_000;
    files.relocate(copied, record('elsewhere.jpg', '2:9'), later);
    expect(hashOf(copied)).toBeNull();
    expect(printOf(copied)).toBe('print of b.jpg');
    expect(files.recentCandidates(10, later).map((file) => file.id)).toEqual([copied]);

    // Merged into the row of the file found there: what was read from that file applies.
    const vanished = add('c.jpg', '1:3');
    const found = add('found.jpg', '2:8');
    files.markMissing(vanished, 1);
    files.transaction(() => {
      files.merge(vanished, found);
    });
    expect(hashOf(vanished)).toBe('hash of found.jpg');

    // A hash read from the file found there wins, even with the same inode number on another drive.
    const lined = add('f.jpg', '1:9');
    const clone = add('clone/f.jpg', '2:9');
    files.markMissing(lined, 1);
    files.transaction(() => {
      files.merge(lined, clone);
    });
    expect(hashOf(lined)).toBe('hash of clone/f.jpg');

    // The drive mounted again, under another device number: still the same file.
    const remounted = add('e.jpg', '1:6');
    files.update(remounted, record('e.jpg', '9:6'), false);
    expect(hashOf(remounted)).toBe('hash of e.jpg');
    expect(printOf(remounted)).toBe('print of e.jpg');

    // Another file put at the same path, with the same size and modification time.
    const replaced = add('d.jpg', '1:4');
    files.update(replaced, record('d.jpg', '1:5'), false);
    expect(hashOf(replaced)).toBeNull();
    expect(printOf(replaced)).toBeNull();
  });
});
