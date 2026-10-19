import { describe, expect, it } from 'vitest';
import { createTestLibrary } from '../testing/test-library';
import type { ImportCandidate } from './files-repository';

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

  it('finds present and missing files of some sizes, but never empty ones', () => {
    const { files, root, addFile } = createTestLibrary();
    const present = addFile('trips/a.jpg', { size: 10, mtimeMs: 5, fingerprint: 'print' });
    const gone = addFile('b.jpg', { size: 20, contentHash: 'hash', missingSince: 1 });
    addFile('other-size.jpg', { size: 30 });
    addFile('empty.jpg', { size: 0 });

    const found = files.withSizes([10, 20, 0]).sort((a, b) => a.id - b.id);
    expect(found).toEqual([
      {
        id: present,
        rootId: root.id,
        path: '/library/trips/a.jpg',
        dir: 'trips',
        name: 'a.jpg',
        size: 10,
        mtimeMs: 5,
        fileId: null,
        fingerprint: 'print',
        contentHash: null,
        missing: false,
      },
      expect.objectContaining({ id: gone, contentHash: 'hash', missing: true }),
    ]);
  });

  it('pages through files of some sizes by size, then id, a size across pages included', () => {
    const { files, roots, root, addFile } = createTestLibrary();
    const other = roots.insert('/other');
    const a = addFile('a.jpg', { size: 20 });
    const b = addFile('b.jpg', { size: 10 });
    const c = addFile('c.jpg', { size: 20, missingSince: 1 });
    const d = addFile('d.jpg', { size: 10, root: other });
    const e = addFile('e.jpg', { size: 30 });
    const f = addFile('f.jpg', { size: 20 });
    addFile('g.jpg', { size: 40 });
    const sizes = [30, 20, 10];
    const byOrder = [b, d, a, c, f, e];

    expect(files.withSizes(sizes).map((file) => file.id)).toEqual(byOrder);
    for (const limit of [1, 2, 4]) {
      const pages: number[][] = [];
      let page: ImportCandidate[] = [];
      do {
        page = files.withSizes(sizes, limit, page.at(-1) ?? null);
        pages.push(page.map((file) => file.id));
      } while (page.length === limit);
      expect(pages.flat()).toEqual(byOrder);
      expect(pages.every((ids) => ids.length <= limit)).toBe(true);
    }
    expect(files.withSizes(sizes, 2, { size: 20, id: a })).toEqual([
      expect.objectContaining({ id: c, rootId: root.id, missing: true }),
      expect.objectContaining({ id: f, missing: false }),
    ]);
  });

  it('finds files by name within one library folder, folding ASCII case only', () => {
    const { files, roots, root, addFile } = createTestLibrary();
    const other = roots.insert('/other');
    const nested = addFile('2024/IMG_0001.JPG');
    const lower = addFile('img_0001.jpg', { missingSince: 1 });
    addFile('IMG_0001.JPG', { root: other });
    addFile('ÉTÉ.jpg');

    const ids = (name: string): number[] =>
      files
        .named(name, root.id)
        .map((file) => file.id)
        .sort((a, b) => a - b);
    expect(ids('Img_0001.jpg')).toEqual([nested, lower]);
    expect(files.named('img_0001.jpg', root.id).find((file) => file.id === lower)?.missing).toBe(
      true,
    );
    expect(ids('été.jpg')).toEqual([]);
    expect(ids('ÉTÉ.jpg')).toHaveLength(1);
  });

  it('pages through tagged files by id, missing ones included', () => {
    const { files, tags, root, addFile } = createTestLibrary();
    const a = addFile('a.jpg');
    addFile('untagged.jpg');
    const c = addFile('trips/c.jpg', { missingSince: 1 });
    const d = addFile('d.jpg');
    tags.addToFiles([d, a], ['x']);
    tags.addToFiles([d, c], ['y']);

    const first = files.taggedPage(0, 2);
    expect(first.map((file) => [file.id, file.missing])).toEqual([
      [a, false],
      [c, true],
    ]);
    expect(first[1]).toEqual({
      id: c,
      rootId: root.id,
      path: '/library/trips/c.jpg',
      dir: 'trips',
      name: 'c.jpg',
      size: 1_000,
      mtimeMs: expect.any(Number) as number,
      fingerprint: null,
      contentHash: null,
      missing: true,
    });
    // `d` has two tags but comes once.
    expect(files.taggedPage(c, 2).map((file) => file.id)).toEqual([d]);
    expect(files.taggedPage(d, 2)).toEqual([]);
  });

  it('takes snapshots of the files still indexed', () => {
    const { files, root, addFile } = createTestLibrary();
    const kept = addFile('trips/a.jpg', { size: 10, mtimeMs: 5 });
    const gone = addFile('c.jpg', { size: 20, mtimeMs: 6, missingSince: 1 });
    const deleted = addFile('b.jpg');
    files.delete([deleted]);

    expect(files.snapshots([kept, gone, deleted, 999])).toEqual([
      {
        id: kept,
        rootId: root.id,
        dir: 'trips',
        name: 'a.jpg',
        size: 10,
        mtimeMs: 5,
        missing: false,
      },
      { id: gone, rootId: root.id, dir: '', name: 'c.jpg', size: 20, mtimeMs: 6, missing: true },
    ]);
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
