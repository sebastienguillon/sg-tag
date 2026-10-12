import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
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
    reconciler = new Reconciler(library.files);
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

  it('forgets a file deleted by the app, unless a file is back at its path', async () => {
    await write('a.jpg');
    await scan();
    const id = idOf('a.jpg') ?? 0;

    expect((await reconciler.forget(id)).deleted).toEqual([]);
    await rm(file('a.jpg'));
    expect((await reconciler.forget(id)).deleted).toEqual([id]);
    expect(details(id)).toBeNull();
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
