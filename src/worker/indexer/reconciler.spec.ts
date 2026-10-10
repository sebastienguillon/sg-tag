import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { crawl, statFiles } from './crawler';
import { fingerprint } from './fingerprint';
import type { ChangeSet } from './reconciler';
import { Reconciler } from './reconciler';

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

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-'));
    library = createTestLibrary();
    root = library.roots.insert(dir);
    reconciler = new Reconciler(library.files);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('indexes media files only, and forgets untagged files that disappear', async () => {
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
    expect((await scan()).deleted).toEqual([b]);
    expect(library.files.count()).toBe(1);
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
    library.files.setFingerprint(id, await fingerprint(file('a.jpg'), 'unique content'.length));

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
    library.files.setFingerprint(id, await fingerprint(file('a.jpg'), 4));

    await rm(file('a.jpg'));
    await write('b.jpg', 'bbbb');
    await scan();

    expect(idOf('b.jpg')).not.toBe(id);
    expect(details(id)?.missing).toBe(true);
  });

  it('applies watcher deletions of whole folders', async () => {
    await write('trip/x.jpg');
    await write('trip/y.jpg');
    await write('z.jpg');
    await scan();
    await rm(file('trip'), { recursive: true });

    const changes = await reconciler.applyPaths(root, [], [file('trip')]);
    expect(changes.deleted).toHaveLength(2);
    expect(library.files.count()).toBe(1);
  });
});
