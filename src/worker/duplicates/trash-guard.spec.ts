import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crawl, statFiles } from '../indexer/crawler';
import { Reconciler } from '../indexer/reconciler';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { DuplicateFinder } from './duplicate-finder';
import { TrashGuard } from './trash-guard';

describe('TrashGuard', () => {
  let dir: string;
  let library: TestLibrary;
  let root: RootRecord;
  let guard: TrashGuard;
  let offline: Set<number>;
  let expected: number[];

  const file = (relative: string): string => path.join(dir, ...relative.split('/'));
  const write = async (relative: string, content: string): Promise<void> => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), content);
  };
  /** Indexes the folder, then compares contents as Find duplicates does. */
  const index = async (...roots: RootRecord[]): Promise<void> => {
    for (const each of [root, ...roots]) {
      await new Reconciler(library.files).syncRoot(each, await statFiles(await crawl(each.path)));
    }
    await new DuplicateFinder({
      files: library.files,
      isOnline: () => true,
      onHashed: () => undefined,
      onProgress: () => undefined,
    }).checkLibrary();
  };
  const idOf = (absolute: string): number => library.files.findByPath(absolute)?.id ?? 0;
  const tagsOf = (id: number): string[] => library.tags.forFile(id).map((tag) => tag.path);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-trash-'));
    library = createTestLibrary();
    root = library.roots.insert(dir);
    offline = new Set();
    expected = [];
    guard = new TrashGuard({
      files: library.files,
      tags: library.tags,
      isOnline: (rootId) => !offline.has(rootId),
      expectDeletion: (id) => expected.push(id),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives the tags to the copy that stays, and takes them back if the file stays too', async () => {
    await write('a.jpg', 'same content');
    await write('backup/a.jpg', 'same content');
    await index();
    const a = idOf(file('a.jpg'));
    const copy = idOf(file('backup/a.jpg'));
    library.tags.addToFiles([a], ['keep', 'trip']);
    library.tags.addToFiles([copy], ['keep']);

    expect(await guard.prepare(a)).toBe(file('a.jpg'));
    expect(tagsOf(copy)).toEqual(['keep', 'trip']);
    expect(expected).toEqual([a]);
    // Trashing failed: only the tags given for it are taken back.
    expect(await guard.settle(a, false)).toBe(true);
    expect(tagsOf(copy)).toEqual(['keep']);

    await guard.prepare(a);
    expect(await guard.settle(a, true)).toBe(false);
    expect(tagsOf(copy)).toEqual(['keep', 'trip']);
  });

  it('lets the copy keep the tags whenever the file may be gone', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await write('other.jpg', 'other content');
    await index();
    const a = idOf(file('a.jpg'));
    const b = idOf(file('b.jpg'));
    library.tags.addToFiles([a], ['trip']);

    // Reported as failed, yet gone from disk.
    await guard.prepare(a);
    await rm(file('a.jpg'));
    expect(await guard.settle(a, false)).toBe(false);
    expect(tagsOf(b)).toEqual(['trip']);

    // Reported as failed, but another file is at its path now.
    library.tags.removeFromFiles(
      [b],
      library.tags.forFile(b).map((tag) => tag.id),
    );
    await write('a.jpg', 'same content');
    await index();
    const again = idOf(file('a.jpg'));
    library.tags.addToFiles([again], ['trip']);
    await guard.prepare(again);
    await rename(file('other.jpg'), file('a.jpg'));
    expect(await guard.settle(again, false)).toBe(false);
    expect(tagsOf(b)).toEqual(['trip']);
  });

  it('refuses when the file, or every copy, changed since they were compared', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await index();
    const a = idOf(file('a.jpg'));
    const b = idOf(file('b.jpg'));

    await utimes(file('b.jpg'), new Date(), new Date(2_000_000_000_000));
    await expect(guard.prepare(a)).rejects.toThrow('No identical copy');
    await expect(guard.prepare(b)).rejects.toThrow('changed since it was compared');
    expect(expected).toEqual([]);
  });

  it('never counts the file itself, seen through a link, as the copy that stays', async (context) => {
    await write('photo.jpg', 'only content');
    // Windows only lets privileged users or developer mode create symbolic links.
    const linked = await symlink(file('photo.jpg'), file('alias.jpg')).then(
      () => true,
      () => false,
    );
    if (!linked) {
      context.skip();
    }
    await index();
    const photo = idOf(file('photo.jpg'));
    const alias = idOf(file('alias.jpg'));
    expect(alias).not.toBe(0);

    expect(library.files.copies(photo)).toEqual([]);
    await expect(guard.prepare(photo)).rejects.toThrow('No identical copy');
    await expect(guard.prepare(alias)).rejects.toThrow('No identical copy');
  });

  it('says so when the only copies are on a drive that is not connected', async () => {
    const otherDir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-trash-other-'));
    try {
      const other = library.roots.insert(otherDir);
      await write('a.jpg', 'same content');
      await writeFile(path.join(otherDir, 'a.jpg'), 'same content');
      await index(other);
      offline.add(other.id);

      await expect(guard.prepare(idOf(file('a.jpg')))).rejects.toThrow('not connected');
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('never lets two copies go at once', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await index();
    const a = idOf(file('a.jpg'));
    const b = idOf(file('b.jpg'));

    const [first, second] = await Promise.allSettled([guard.prepare(a), guard.prepare(b)]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: new Error('Its identical copy is being moved to the Trash, so this one was kept.'),
    });
    await expect(guard.prepare(a)).rejects.toThrow('already being moved');

    // a could not be trashed after all: b may go now.
    await guard.settle(a, false);
    expect(await guard.prepare(b)).toBe(file('b.jpg'));
  });
});
