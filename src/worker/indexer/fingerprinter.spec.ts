import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRecord, FilesRepository } from '../library/files-repository';
import { ThumbState } from '../library/files-repository';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { Fingerprinter } from './fingerprinter';

/** Every file holds its own name, padded to the same size. */
const SIZE = 64;

interface IndexOptions {
  readonly mtimeMs?: number;
  /** Defaults to a done thumbnail: what background work waits for. */
  readonly thumb?: ThumbState;
  readonly root?: RootRecord;
}

describe('Fingerprinter', () => {
  let dir: string;
  let library: TestLibrary;
  let root: RootRecord;
  let offline: Set<number>;
  let fingerprinter: Fingerprinter;
  let setFingerprint: MockInstance<FilesRepository['setFingerprint']>;
  let clock: number;

  const file = (relative: string): string => path.join(dir, ...relative.split('/'));
  const write = async (relative: string): Promise<void> => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), relative.padEnd(SIZE));
  };
  const record = (relative: string, mtimeMs = clock++, at = root): FileRecord => ({
    rootId: at.id,
    path: file(relative),
    dir: path
      .relative(at.path, path.dirname(file(relative)))
      .split(path.sep)
      .join('/'),
    name: path.basename(relative),
    ext: 'jpg',
    kind: 'image',
    size: SIZE,
    mtimeMs,
    birthtimeMs: null,
    fileId: null,
  });
  /** Indexes a file, on disk or not, and returns its id. Later files are newer. */
  const index = (relative: string, options: IndexOptions = {}): number => {
    const id = library.files.insert(record(relative, options.mtimeMs, options.root));
    library.files.setThumb(id, options.thumb ?? ThumbState.ready);
    return id;
  };
  const add = async (relative: string, options: IndexOptions = {}): Promise<number> => {
    await write(relative);
    return index(relative, options);
  };
  /** Names of the files fingerprinted so far, in order. */
  const stored = (): string[] =>
    setFingerprint.mock.calls.map(([target]) => path.basename(target.path));
  const fingerprintOf = (relative: string): string | null =>
    library.files.findByPath(file(relative))?.fingerprint ?? null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sg-tag-prints-'));
    library = createTestLibrary();
    root = library.roots.insert(dir);
    offline = new Set();
    clock = 1_000;
    setFingerprint = vi.spyOn(library.files, 'setFingerprint');
    fingerprinter = new Fingerprinter({
      files: library.files,
      offlineRootIds: () => [...offline],
    });
  });

  afterEach(async () => {
    fingerprinter.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('fingerprints files in the background once their thumbnail is done, newest first', async () => {
    const ready = await add('ready.jpg', { mtimeMs: 1_000, thumb: ThumbState.pending });
    const system = await add('system.jpg', { mtimeMs: 3_000, thumb: ThumbState.pending });
    const failed = await add('failed.jpg', { mtimeMs: 2_000, thumb: ThumbState.pending });
    await add('pending.jpg', { mtimeMs: 4_000, thumb: ThumbState.pending });
    fingerprinter.startBackground();

    // Thumbnails from the OS, or none at all, are done too.
    library.files.setThumb(ready, ThumbState.ready);
    library.files.setThumb(system, ThumbState.system);
    library.files.setThumb(failed, ThumbState.failed);
    fingerprinter.wake();

    await vi.waitFor(() => {
      expect(stored()).toEqual(['system.jpg', 'failed.jpg', 'ready.jpg']);
    });
    expect(fingerprintOf('system.jpg')).not.toBeNull();
    expect(fingerprintOf('pending.jpg')).toBeNull();
  });

  it('skips files on drives that are not connected', async () => {
    const away = library.roots.insert(file('away'));
    await add('here.jpg');
    await add('away/away.jpg', { root: away });
    offline.add(away.id);
    fingerprinter.startBackground();
    await vi.waitFor(() => {
      expect(stored()).toEqual(['here.jpg']);
    });

    offline.delete(away.id);
    fingerprinter.retryFailed();
    await vi.waitFor(() => {
      expect(stored()).toEqual(['here.jpg', 'away.jpg']);
    });
  });

  it('fingerprints tagged files ahead of background work, and only them', async () => {
    for (const name of ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']) {
      await add(name);
    }
    const tagged = await add('tagged.jpg', { thumb: ThumbState.pending });
    const untagged = await add('untagged.jpg', { thumb: ThumbState.pending });
    library.tags.addToFiles([tagged], ['keep']);

    fingerprinter.startBackground();
    fingerprinter.prioritize([tagged, untagged]);

    await vi.waitFor(() => {
      expect(stored()).toHaveLength(6);
    });
    expect(stored()).toContain('tagged.jpg');
    expect(stored().at(-1)).toBe('1.jpg');
    expect(fingerprintOf('untagged.jpg')).toBeNull();
  });

  it('leaves an unreadable file alone until it changes or a drive comes back', async () => {
    index('retried.jpg', { mtimeMs: 5_000 });
    const woken = index('woken.jpg', { mtimeMs: 4_000 });
    await add('first.jpg', { mtimeMs: 1_000 });
    fingerprinter.startBackground();
    await vi.waitFor(() => {
      expect(stored()).toEqual(['first.jpg']);
    });

    // Readable now, but not tried again on mere new work.
    await write('retried.jpg');
    await write('woken.jpg');
    await add('second.jpg', { mtimeMs: 2_000 });
    fingerprinter.wake();
    await vi.waitFor(() => {
      expect(stored()).toEqual(['first.jpg', 'second.jpg']);
    });

    fingerprinter.wake([woken]);
    await vi.waitFor(() => {
      expect(stored()).toEqual(['first.jpg', 'second.jpg', 'woken.jpg']);
    });

    fingerprinter.retryFailed();
    await vi.waitFor(() => {
      expect(stored()).toEqual(['first.jpg', 'second.jpg', 'woken.jpg', 'retried.jpg']);
    });
  });

  it('reads a file renamed while it was queued where it is now', async () => {
    const moved = await add('before.jpg', { mtimeMs: 1_000 });
    await add('newer.jpg', { mtimeMs: 2_000 });

    // newer.jpg is being read; before.jpg waits with the path it had.
    fingerprinter.startBackground();
    renameSync(file('before.jpg'), file('after.jpg'));
    library.files.relocate(moved, record('after.jpg', 1_000));
    fingerprinter.wake([moved]);

    await vi.waitFor(() => {
      expect(fingerprintOf('after.jpg')).not.toBeNull();
    });
  });

  it('reads a tagged file renamed while it was queued where it is now, without waiting for its thumbnail', async () => {
    await add('background.jpg');
    const first = await add('first.jpg', { thumb: ThumbState.pending });
    const moved = await add('before.jpg', { mtimeMs: 1_000, thumb: ThumbState.pending });
    library.tags.addToFiles([first, moved], ['keep']);

    // background.jpg and first.jpg are being read; before.jpg waits with the path it had.
    fingerprinter.startBackground();
    fingerprinter.prioritize([first]);
    fingerprinter.prioritize([moved]);
    renameSync(file('before.jpg'), file('after.jpg'));
    library.files.relocate(moved, record('after.jpg', 1_000));
    fingerprinter.prioritize([moved]);
    fingerprinter.wake([moved]);

    await vi.waitFor(() => {
      expect(fingerprintOf('after.jpg')).not.toBeNull();
    });
  });

  it('stops refilling background work', async () => {
    await add('a.jpg');
    fingerprinter.startBackground();
    await vi.waitFor(() => {
      expect(stored()).toEqual(['a.jpg']);
    });

    fingerprinter.stop();
    await add('b.jpg');
    fingerprinter.wake();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stored()).toEqual(['a.jpg']);
  });
});
