import type { DuplicateCheck } from '@shared/model';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crawl, statFiles } from '../indexer/crawler';
import { Reconciler } from '../indexer/reconciler';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { DuplicateFinder } from './duplicate-finder';

describe('DuplicateFinder', () => {
  let dir: string;
  let library: TestLibrary;
  let root: RootRecord;
  let finder: DuplicateFinder;
  let offline: Set<number>;
  let hashed: number[];
  let progress: DuplicateCheck[];

  const file = (relative: string): string => path.join(dir, ...relative.split('/'));
  const write = async (relative: string, content: string | Buffer): Promise<void> => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), content);
  };
  const scan = async (): Promise<void> => {
    await new Reconciler(library.files).syncRoot(root, await statFiles(await crawl(dir)));
  };
  const idOf = (relative: string): number => library.files.findByPath(file(relative))?.id ?? 0;
  const copiesOf = (relative: string): number[] =>
    library.files.copies(idOf(relative)).map((copy) => copy.id);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-dupes-'));
    library = createTestLibrary();
    root = library.roots.insert(dir);
    offline = new Set();
    hashed = [];
    progress = [];
    finder = new DuplicateFinder({
      files: library.files,
      isOnline: (rootId) => !offline.has(rootId),
      onHashed: (ids) => hashed.push(...ids),
      onProgress: () => {
        const current = finder.progress;
        if (current) {
          progress.push(current);
        }
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds byte-identical files, and only those', async () => {
    await write('a.jpg', 'same content');
    await write('backup/a copy.jpg', 'same content');
    await write('other.jpg', 'diff content');
    await write('alone.jpg', 'a size of its own');
    await scan();

    expect(await finder.checkLibrary()).toBe(2);
    expect(copiesOf('a.jpg')).toEqual([idOf('backup/a copy.jpg')]);
    expect(copiesOf('backup/a copy.jpg')).toEqual([idOf('a.jpg')]);
    expect(copiesOf('other.jpg')).toEqual([]);
    expect(finder.progress).toBeNull();
  });

  it('tells apart files with the same size, beginning and end', async () => {
    // The fingerprint covers the first and last 64 KiB only: these differ in the middle.
    const edge = Buffer.alloc(64 * 1024, 1);
    await write('a.png', Buffer.concat([edge, Buffer.from('A'), edge]));
    await write('b.png', Buffer.concat([edge, Buffer.from('B'), edge]));
    await scan();

    expect(await finder.checkLibrary()).toBe(0);
    expect(library.files.findByPath(file('a.png'))?.fingerprint).toBe(
      library.files.findByPath(file('b.png'))?.fingerprint,
    );
  });

  it('only reads what concerns the files just tagged', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await write('c.jpg', 'other pair, same');
    await write('d.jpg', 'other pair, same');
    await scan();

    await finder.check([idOf('a.jpg')]);

    expect(copiesOf('a.jpg')).toEqual([idOf('b.jpg')]);
    expect(hashed).toEqual([idOf('a.jpg'), idOf('b.jpg')]);
    expect(library.files.findByPath(file('c.jpg'))?.fingerprint).toBeNull();
  });

  it('does not read files again once their content is known', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await scan();

    await finder.checkLibrary();
    expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
    progress = [];
    await finder.checkLibrary();
    expect(progress).toEqual([{ done: 0, total: 0 }]);
  });

  it('skips files on drives that are not connected', async () => {
    await write('a.jpg', 'same content');
    await write('b.jpg', 'same content');
    await scan();
    offline.add(root.id);

    expect(await finder.checkLibrary()).toBe(0);
    expect(hashed).toEqual([]);
  });
});
