import { copyFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import type { DiskFile } from './crawler';
import { crawl, statFile, statFiles } from './crawler';
import { fingerprint } from './fingerprint';
import type { ChangeSet } from './reconciler';
import { MOVE_WINDOW_MS, Reconciler } from './reconciler';

describe('Reconciler', () => {
  let dir: string;
  let library: TestLibrary;
  let root: RootRecord;
  let reconciler: Reconciler;
  /** The reconciler's clock. */
  let now: number;

  const file = (relative: string): string => path.join(dir, ...relative.split('/'));
  const write = async (relative: string, content = relative): Promise<void> => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), content);
  };
  const scan = async (): Promise<ChangeSet> =>
    reconciler.syncRoot(root, await statFiles(await crawl(dir)));
  const idOf = (relative: string): number | undefined =>
    library.files.findByPath(file(relative))?.id;
  const details = (id: number) => library.files.details(id, new Set());
  const tagsOf = (id: number): string[] => library.tags.forFile(id).map((tag) => tag.path);
  /** What the watcher reports for a path that exists. */
  const stat = async (absolute: string): Promise<DiskFile> => {
    const disk = await statFile(absolute);
    if (!disk) {
      throw new Error(`${absolute} is not on disk`);
    }
    return disk;
  };
  /** An old modification time: a file created later cannot take it for the same inode, reused. */
  const age = (relative: string): Promise<void> =>
    utimes(file(relative), new Date(), new Date(1_000_000_000_000));
  const storeFingerprint = async (relative: string): Promise<void> => {
    const known = library.files.findByPath(file(relative));
    if (known) {
      library.files.setFingerprint(known, await fingerprint(known.path, known.size));
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-'));
    library = createTestLibrary();
    root = library.roots.insert(dir);
    now = Date.now();
    reconciler = new Reconciler(library.files, () => now);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('indexes media files only, and forgets untagged files a while after they disappear', async () => {
    await write('a.jpg');
    await write('clips/b.MP4');
    await write('notes.txt');
    await write('.hidden.jpg');
    await write('._a.jpg');
    await write('node_modules/x.png');
    await write('Photos Library.photoslibrary/originals/y.heic');
    await scan();
    expect(library.files.count()).toBe(2);
    expect(details(idOf('clips/b.MP4') ?? 0)).toMatchObject({
      kind: 'video',
      format: 'MP4',
      folder: 'clips',
    });

    const b = idOf('clips/b.MP4');
    await rm(file('clips/b.MP4'));
    expect((await scan()).changed).toEqual([b]);
    expect(library.files.count()).toBe(1);
    expect(reconciler.sweep().deleted).toEqual([]);
    expect(reconciler.sweep(Date.now() + MOVE_WINDOW_MS + 1).deleted).toEqual([b]);
  });

  it('keeps the id of an untagged file that is renamed', async () => {
    await write('a.jpg');
    await scan();
    const id = idOf('a.jpg');

    await rename(file('a.jpg'), file('b.jpg'));
    await scan();

    expect(idOf('b.jpg')).toBe(id);
  });

  it('keeps id and tags of a tagged file renamed and moved on the same volume', async () => {
    await write('a.jpg');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);

    await mkdir(file('moved'));
    await rename(file('a.jpg'), file('moved/renamed.jpg'));
    await scan();

    expect(idOf('moved/renamed.jpg')).toBe(id);
    expect(details(id)).toMatchObject({ name: 'renamed.jpg', folder: 'moved', missing: false });
    expect(library.tags.forFile(id).map((tag) => tag.path)).toEqual(['keep']);
  });

  it('keeps vanished tagged files as missing until they reappear', async () => {
    await write('a.jpg');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);

    await rename(file('a.jpg'), path.join(os.tmpdir(), `sg-tag-away-${id}.jpg`));
    await scan();
    expect(details(id)?.missing).toBe(true);
    expect(library.files.count()).toBe(0);

    await rename(path.join(os.tmpdir(), `sg-tag-away-${id}.jpg`), file('a.jpg'));
    await scan();
    expect(details(id)?.missing).toBe(false);
  });

  it('recognises a tagged file copied elsewhere (new inode) by its fingerprint', async () => {
    await write('a.jpg', 'unique content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    await copyFile(file('a.jpg'), file('copy.jpg'));
    await rm(file('a.jpg'));
    await scan();

    expect(idOf('copy.jpg')).toBe(id);
    expect(library.tags.forFile(id)).toHaveLength(1);
  });

  it('does not mistake a different file of the same size for a missing one', async () => {
    await write('a.jpg', 'aaaa');
    await age('a.jpg');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    await rm(file('a.jpg'));
    await write('b.jpg', 'bbbb');
    await scan();

    expect(idOf('b.jpg')).not.toBe(id);
    expect(details(id)?.missing).toBe(true);
  });

  it('recognises a file whose copy was seen before the original vanished', async () => {
    await write('a.jpg', 'unique content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    // A move to another drive: the copy is created, and tagged meanwhile, then the source deleted.
    await copyFile(file('a.jpg'), file('copy.jpg'));
    await reconciler.applyPaths(root, [await stat(file('copy.jpg'))], []);
    const copy = idOf('copy.jpg') ?? 0;
    library.tags.addToFiles([copy], ['copied']);
    await rm(file('a.jpg'));
    const changes = await reconciler.applyPaths(root, [], [file('a.jpg')]);

    expect(idOf('copy.jpg')).toBe(id);
    expect(tagsOf(id)).toEqual(['copied', 'keep']);
    expect(details(id)?.missing).toBe(false);
    expect(changes.deleted).toEqual([copy]);
  });

  it('recognises a copy that was still being written when its source vanished', async () => {
    await write('a.jpg', 'unique content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    await writeFile(file('copy.jpg'), 'unique');
    await reconciler.applyPaths(root, [await stat(file('copy.jpg'))], []);
    await rm(file('a.jpg'));
    await reconciler.applyPaths(root, [], [file('a.jpg')]);
    expect(details(id)?.missing).toBe(true);

    await writeFile(file('copy.jpg'), 'unique content');
    await reconciler.applyPaths(root, [await stat(file('copy.jpg'))], []);

    expect(idOf('copy.jpg')).toBe(id);
    expect(tagsOf(id)).toEqual(['keep']);
  });

  it('follows moves between library folders, whichever watcher reports first', async () => {
    const otherDir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-other-'));
    try {
      const other = library.roots.insert(otherDir);
      await write('first.jpg', 'first');
      await write('second.jpg', 'second');
      await scan();
      const first = idOf('first.jpg') ?? 0;
      const second = idOf('second.jpg') ?? 0;

      // The destination's watcher reports first…
      await rename(file('first.jpg'), path.join(otherDir, 'first.jpg'));
      await reconciler.applyPaths(other, [await stat(path.join(otherDir, 'first.jpg'))], []);
      await reconciler.applyPaths(root, [], [file('first.jpg')]);
      // …or the source's.
      await rename(file('second.jpg'), path.join(otherDir, 'second.jpg'));
      await reconciler.applyPaths(root, [], [file('second.jpg')]);
      await reconciler.applyPaths(other, [await stat(path.join(otherDir, 'second.jpg'))], []);

      expect(library.files.findByPath(path.join(otherDir, 'first.jpg'))?.id).toBe(first);
      expect(library.files.findByPath(path.join(otherDir, 'second.jpg'))?.id).toBe(second);
      expect(library.files.count()).toBe(2);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('does not take a file added long before for the new location of one that vanishes', async () => {
    await write('a.jpg', 'unique content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');
    await copyFile(file('a.jpg'), file('copy.jpg'));
    await reconciler.applyPaths(root, [await stat(file('copy.jpg'))], []);
    const copy = idOf('copy.jpg');

    now += MOVE_WINDOW_MS + 1;
    await rm(file('a.jpg'));
    await reconciler.applyPaths(root, [], [file('a.jpg')]);

    expect(idOf('copy.jpg')).toBe(copy);
    expect(details(id)?.missing).toBe(true);
  });

  it('follows a file renamed onto the path of a file that vanished shortly before', async () => {
    await write('old.jpg', 'old');
    await write('edit.jpg', 'edited');
    await write('old2.jpg', 'old2');
    await write('edit2.jpg', 'edited2');
    await scan();
    const old = idOf('old.jpg') ?? 0;
    const edit = idOf('edit.jpg') ?? 0;
    const old2 = idOf('old2.jpg') ?? 0;
    const edit2 = idOf('edit2.jpg') ?? 0;
    library.tags.addToFiles([edit, edit2], ['keep']);
    now += MOVE_WINDOW_MS + 1;
    // The untagged files are deleted: kept a while as missing, in case they moved.
    await rm(file('old.jpg'));
    await rm(file('old2.jpg'));
    await scan();

    // Seen in one go…
    await rename(file('edit.jpg'), file('old.jpg'));
    await scan();
    // …or the new path first, then the old one gone.
    await rename(file('edit2.jpg'), file('old2.jpg'));
    await reconciler.applyPaths(root, [await stat(file('old2.jpg'))], []);
    await reconciler.applyPaths(root, [], [file('edit2.jpg')]);

    expect(idOf('old.jpg')).toBe(edit);
    expect(idOf('old2.jpg')).toBe(edit2);
    expect(tagsOf(edit)).toEqual(['keep']);
    expect(tagsOf(edit2)).toEqual(['keep']);
    expect(details(old)).toBeNull();
    expect(details(old2)).toBeNull();
  });

  it('lets a moved file claim its copy from an identical file that vanished before', async () => {
    await write('a.jpg', 'same content');
    await write('backup/b.jpg', 'same content');
    await scan();
    const a = idOf('a.jpg') ?? 0;
    const b = idOf('backup/b.jpg') ?? 0;
    library.tags.addToFiles([a], ['keep']);
    await storeFingerprint('a.jpg');
    await storeFingerprint('backup/b.jpg');
    now += MOVE_WINDOW_MS + 1;

    // The untagged copy is deleted, then a.jpg moved to another drive: copied, then deleted.
    await rm(file('backup/b.jpg'));
    await reconciler.applyPaths(root, [], [file('backup/b.jpg')]);
    await mkdir(file('drive'));
    await copyFile(file('a.jpg'), file('drive/a.jpg'));
    await reconciler.applyPaths(root, [await stat(file('drive/a.jpg'))], []);
    await rm(file('a.jpg'));
    await reconciler.applyPaths(root, [], [file('a.jpg')]);

    expect(idOf('drive/a.jpg')).toBe(a);
    expect(tagsOf(a)).toEqual(['keep']);
    expect(details(b)).toBeNull();
  });

  it('pairs identical files moved together by their names and folders', async () => {
    await write('A/clientY/logo.png', 'logo');
    await scan();
    await write('A/clientX/logo.png', 'logo');
    await scan();
    const x = idOf('A/clientX/logo.png') ?? 0;
    const y = idOf('A/clientY/logo.png') ?? 0;
    library.tags.addToFiles([x], ['clientX']);
    library.tags.addToFiles([y], ['clientY']);
    await storeFingerprint('A/clientX/logo.png');
    await storeFingerprint('A/clientY/logo.png');

    // Moved to another drive: copied (new inodes), then deleted.
    for (const client of ['clientX', 'clientY']) {
      await mkdir(file(`B/${client}`), { recursive: true });
      await copyFile(file(`A/${client}/logo.png`), file(`B/${client}/logo.png`));
    }
    await rm(file('A'), { recursive: true });
    await reconciler.applyPaths(
      root,
      [await stat(file('B/clientX/logo.png')), await stat(file('B/clientY/logo.png'))],
      [file('A')],
    );

    expect(idOf('B/clientX/logo.png')).toBe(x);
    expect(idOf('B/clientY/logo.png')).toBe(y);
  });

  it('never takes one empty file for another', async () => {
    await write('a.jpg', '');
    await age('a.jpg');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    // An empty file added before the tagged one vanishes, and one after.
    await write('before.jpg', '');
    await reconciler.applyPaths(root, [await stat(file('before.jpg'))], []);
    await rm(file('a.jpg'));
    await reconciler.applyPaths(root, [], [file('a.jpg')]);
    await write('after.jpg', '');
    await reconciler.applyPaths(root, [await stat(file('after.jpg'))], []);

    expect(idOf('before.jpg')).not.toBe(id);
    expect(idOf('after.jpg')).not.toBe(id);
    expect(details(id)?.missing).toBe(true);
  });

  it('stores the fingerprint it reads from a recent file', async () => {
    await write('a.jpg', 'unique content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    await storeFingerprint('a.jpg');
    // Same size, other content, added before the copy: read first, and not a match.
    await write('other.jpg', 'unique CONTENT');
    await reconciler.applyPaths(root, [await stat(file('other.jpg'))], []);
    await copyFile(file('a.jpg'), file('copy.jpg'));
    await reconciler.applyPaths(root, [await stat(file('copy.jpg'))], []);

    await rm(file('a.jpg'));
    await reconciler.applyPaths(root, [], [file('a.jpg')]);

    expect(idOf('copy.jpg')).toBe(id);
    expect(library.files.findByPath(file('other.jpg'))?.fingerprint).toBe(
      await fingerprint(file('other.jpg'), 14),
    );
  });

  it('indexes a file reported twice in one batch once', async () => {
    // A folder created with its files: the folder is crawled, and each file reported too.
    await write('trip/a.jpg');
    const disk = await stat(file('trip/a.jpg'));

    await reconciler.applyPaths(root, [disk, disk], []);

    expect(library.files.count()).toBe(1);
  });

  it('gives identical files restored together their own rows back', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await scan();
    const a = idOf('a.jpg') ?? 0;
    const b = idOf('b.jpg') ?? 0;
    library.tags.addToFiles([a], ['keep']);
    await storeFingerprint('a.jpg');
    await rm(file('a.jpg'));
    await rm(file('b.jpg'));
    await scan();

    // Restored from a backup: new inodes, and b listed first (it has no fingerprint yet).
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await reconciler.applyPaths(root, [await stat(file('b.jpg')), await stat(file('a.jpg'))], []);

    expect(idOf('a.jpg')).toBe(a);
    expect(idOf('b.jpg')).toBe(b);
    expect(tagsOf(a)).toEqual(['keep']);
  });

  it('matches a file by inode before any copy of it by fingerprint', async () => {
    await write('a.jpg', 'same content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    // While the app was closed: duplicated, then the original renamed.
    await copyFile(file('a.jpg'), file('a copy.jpg'));
    await rename(file('a.jpg'), file('z.jpg'));
    await reconciler.applyPaths(
      root,
      [await stat(file('a copy.jpg')), await stat(file('z.jpg'))],
      [file('a.jpg')],
    );

    expect(idOf('z.jpg')).toBe(id);
    expect(idOf('a copy.jpg')).not.toBe(id);
  });

  it('takes a copy for the file that vanished with it, over an identical one missing before', async () => {
    await write('old/x.jpg', 'same content');
    await write('a/x.jpg', 'same content');
    await scan();
    const old = idOf('old/x.jpg') ?? 0;
    const moved = idOf('a/x.jpg') ?? 0;
    library.tags.addToFiles([old], ['old']);
    library.tags.addToFiles([moved], ['moved']);
    await storeFingerprint('old/x.jpg');
    await storeFingerprint('a/x.jpg');
    now += MOVE_WINDOW_MS + 1;
    await rm(file('old/x.jpg'));
    await scan();
    now += 60_000;

    // a/x.jpg moved to another drive, into a folder named like the other one's.
    await mkdir(file('b/old'), { recursive: true });
    await copyFile(file('a/x.jpg'), file('b/old/x.jpg'));
    await rm(file('a/x.jpg'));
    await reconciler.applyPaths(root, [await stat(file('b/old/x.jpg'))], [file('a/x.jpg')]);

    expect(idOf('b/old/x.jpg')).toBe(moved);
    expect(tagsOf(moved)).toEqual(['moved']);
    expect(details(old)?.missing).toBe(true);
  });

  it('lets two identical files vanish when only one copy appears', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await scan();
    const a = idOf('a.jpg') ?? 0;
    const b = idOf('b.jpg') ?? 0;
    library.tags.addToFiles([a, b], ['keep']);
    await storeFingerprint('a.jpg');
    await storeFingerprint('b.jpg');

    await mkdir(file('drive'));
    await copyFile(file('a.jpg'), file('drive/a.jpg'));
    await rm(file('a.jpg'));
    await rm(file('b.jpg'));
    await reconciler.applyPaths(
      root,
      [await stat(file('drive/a.jpg'))],
      [file('a.jpg'), file('b.jpg')],
    );

    expect(idOf('drive/a.jpg')).toBe(a);
    expect(details(b)?.missing).toBe(true);
  });

  it('lets a file claim its copy put at the path of an identical file that vanished', async () => {
    await write('x.jpg', 'same content');
    await write('other/x.jpg', 'same content');
    await scan();
    const replaced = idOf('x.jpg') ?? 0;
    const source = idOf('other/x.jpg') ?? 0;
    library.tags.addToFiles([source], ['keep']);
    await storeFingerprint('x.jpg');
    await storeFingerprint('other/x.jpg');
    now += MOVE_WINDOW_MS + 1;
    await rm(file('x.jpg'));
    await scan();

    // other/x.jpg moved onto x.jpg from another drive: copied, then deleted.
    await copyFile(file('other/x.jpg'), file('x.jpg'));
    await reconciler.applyPaths(root, [await stat(file('x.jpg'))], []);
    await rm(file('other/x.jpg'));
    await reconciler.applyPaths(root, [], [file('other/x.jpg')]);

    expect(idOf('x.jpg')).toBe(source);
    expect(tagsOf(source)).toEqual(['keep']);
    expect(details(replaced)).toBeNull();
  });

  it('follows missing files back by inode, whatever arrived at their old paths', async () => {
    const away = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-away-'));
    try {
      await write('IMG_0001.jpg', 'holiday');
      await write('x.jpg', 'x content');
      await write('y.jpg', 'y content');
      await scan();
      const photo = idOf('IMG_0001.jpg') ?? 0;
      const x = idOf('x.jpg') ?? 0;
      const y = idOf('y.jpg') ?? 0;
      library.tags.addToFiles([photo], ['holiday']);
      for (const name of ['IMG_0001.jpg', 'x.jpg', 'y.jpg']) {
        await rename(file(name), path.join(away, name));
      }
      await scan();

      // Back while the app was closed: the photo in a subfolder, with a new photo under its old
      // name; x and y swapped.
      await mkdir(file('2019'));
      await rename(path.join(away, 'IMG_0001.jpg'), file('2019/IMG_0001.jpg'));
      await write('IMG_0001.jpg', 'another photo');
      await rename(path.join(away, 'x.jpg'), file('y.jpg'));
      await rename(path.join(away, 'y.jpg'), file('x.jpg'));
      await scan();

      expect(idOf('2019/IMG_0001.jpg')).toBe(photo);
      expect(tagsOf(photo)).toEqual(['holiday']);
      expect(idOf('IMG_0001.jpg')).not.toBe(photo);
      expect(idOf('y.jpg')).toBe(x);
      expect(idOf('x.jpg')).toBe(y);
      expect(library.files.count()).toBe(4);
    } finally {
      await rm(away, { recursive: true, force: true });
    }
  });

  it('follows a file by inode before giving it to an identical file by fingerprint', async () => {
    const otherDir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-other-'));
    try {
      const other = library.roots.insert(otherDir);
      await write('a/dup.jpg', 'same content');
      await write('a/keep.jpg', 'same content');
      await write('b/x.jpg', 'x content');
      await scan();
      const dup = idOf('a/dup.jpg') ?? 0;
      const keep = idOf('a/keep.jpg') ?? 0;
      const x = idOf('b/x.jpg') ?? 0;
      library.tags.addToFiles([keep, x], ['keep']);
      for (const name of ['a/dup.jpg', 'a/keep.jpg', 'b/x.jpg']) {
        await storeFingerprint(name);
      }
      now += MOVE_WINDOW_MS + 1;

      // Moved to another library folder, whose watcher reports first; then the old folder goes,
      // with an identical file in it.
      await rename(file('a/keep.jpg'), path.join(otherDir, 'keep.jpg'));
      await reconciler.applyPaths(other, [await stat(path.join(otherDir, 'keep.jpg'))], []);
      await rm(file('a'), { recursive: true });
      await reconciler.applyPaths(root, [], [file('a')]);
      // Copied within its folder, then moved to another library folder, reported in that order.
      await copyFile(file('b/x.jpg'), file('b/x copy.jpg'));
      await rename(file('b/x.jpg'), path.join(otherDir, 'x.jpg'));
      await reconciler.applyPaths(other, [await stat(path.join(otherDir, 'x.jpg'))], []);
      await reconciler.applyPaths(root, [await stat(file('b/x copy.jpg'))], [file('b/x.jpg')]);

      expect(library.files.findByPath(path.join(otherDir, 'keep.jpg'))?.id).toBe(keep);
      expect(details(dup)?.missing).toBe(true);
      expect(library.files.findByPath(path.join(otherDir, 'x.jpg'))?.id).toBe(x);
      expect(idOf('b/x copy.jpg')).not.toBe(x);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('keeps tagged files that vanished when untagged ones are forgotten', async () => {
    await write('a.jpg');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    library.tags.addToFiles([id], ['keep']);
    await rm(file('a.jpg'));
    await scan();

    expect(reconciler.sweep(Date.now() + MOVE_WINDOW_MS + 1).deleted).toEqual([]);
    expect(details(id)?.missing).toBe(true);
  });

  it('drops a file the app deletes, rather than taking it for moved to its copy', async () => {
    await write('a.jpg', 'same content');
    await write('copy.jpg', 'same content');
    await scan();
    const id = idOf('a.jpg') ?? 0;
    const copy = idOf('copy.jpg');
    library.tags.addToFiles([id], ['keep']);
    await storeFingerprint('a.jpg');

    reconciler.expectDeletion(id);
    await rm(file('a.jpg'));
    const changes = await reconciler.applyPaths(root, [], [file('a.jpg')]);

    expect(changes.deleted).toEqual([id]);
    expect(idOf('copy.jpg')).toBe(copy);
  });

  it('forgets a file deleted by the app, unless it is still at its path', async () => {
    await write('a.jpg');
    await write('b.jpg');
    await scan();
    const a = idOf('a.jpg') ?? 0;
    const b = idOf('b.jpg') ?? 0;

    expect((await reconciler.forget(a)).deleted).toEqual([]);
    await rm(file('a.jpg'));
    expect((await reconciler.forget(a)).deleted).toEqual([a]);
    expect(details(a)).toBeNull();

    // Another file at its path is not it.
    await write('c.jpg');
    await rename(file('c.jpg'), file('b.jpg'));
    expect((await reconciler.forget(b)).deleted).toEqual([b]);
  });

  it('applies watcher deletions of whole folders', async () => {
    await write('trip/x.jpg');
    await write('trip/y.jpg');
    await write('z.jpg');
    await scan();
    await rm(file('trip'), { recursive: true });

    const changes = await reconciler.applyPaths(root, [], [file('trip')]);
    expect(changes.changed).toHaveLength(2);
    expect(library.files.count()).toBe(1);
  });
});
