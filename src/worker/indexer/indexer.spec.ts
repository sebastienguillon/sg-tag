import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RootRecord } from '../library/roots-repository';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { Indexer } from './indexer';
import type { ChangeSet } from './reconciler';
import { MOVE_WINDOW_MS, Reconciler } from './reconciler';

/** The indexer's `SWEEP_INTERVAL_MS`. */
const MINUTE = 60_000;

describe('Indexer', () => {
  let library: TestLibrary;
  let drive: RootRecord;
  let reconciler: Reconciler;
  let indexer: Indexer;
  let reported: ChangeSet[];

  /** Indexes a file of the unplugged drive and returns its id. */
  const add = (name: string): number =>
    library.files.insert({
      rootId: drive.id,
      path: path.join(drive.path, name),
      dir: '',
      name,
      ext: 'jpg',
      kind: 'image',
      size: 1_000,
      mtimeMs: 1,
      birthtimeMs: null,
      fileId: null,
    });
  /** Marks a file as vanished long enough ago to be forgotten, unless it is tagged. */
  const vanishLongAgo = (id: number): void => {
    library.files.markMissing(id, Date.now() - MOVE_WINDOW_MS);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    library = createTestLibrary();
    // `/library` is `/Library` on case-insensitive volumes (macOS): it must not be scanned.
    for (const root of library.roots.list()) {
      library.roots.delete(root.id);
    }
    // A drive that is not plugged in: never scanned nor watched, its files stay indexed.
    drive = library.roots.insert(path.join(os.tmpdir(), `sg-tag-unplugged-${randomUUID()}`));
    reconciler = new Reconciler(library.files);
    reported = [];
    indexer = new Indexer(library.roots, library.files, reconciler, {
      onChanges: (changes) => reported.push(changes),
      onStateChange: () => undefined,
    });
  });

  afterEach(async () => {
    await indexer.stop();
    vi.useRealTimers();
  });

  it('forgets untagged files that vanished a while ago, every minute', async () => {
    const vanished = add('vanished.jpg');
    const tagged = add('tagged.jpg');
    const recent = add('recent.jpg');
    add('present.jpg');
    library.tags.addToFiles([tagged], ['keep']);
    vanishLongAgo(vanished);
    vanishLongAgo(tagged);
    library.files.markMissing(recent, Date.now());
    const sweep = vi.spyOn(reconciler, 'sweep');
    await indexer.start();
    expect(indexer.offlineRootIds).toEqual([drive.id]);

    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toEqual([{ changed: [], deleted: [vanished] }]);

    // Nothing left to forget: the next sweep reports nothing.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(reported).toHaveLength(1);
  });

  it('stops sweeping once stopped', async () => {
    vanishLongAgo(add('vanished.jpg'));
    const sweep = vi.spyOn(reconciler, 'sweep');
    await indexer.start();
    await indexer.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(sweep).not.toHaveBeenCalled();
    expect(reported).toEqual([]);
  });

  it('applies sweeps and forget calls one at a time, in order', async () => {
    const kept = add('kept.jpg');
    const trashed = add('trashed.jpg');
    const vanished = add('vanished.jpg');
    vanishLongAgo(vanished);
    // The first file is still on disk, which takes a while to find out.
    const stillThere = Promise.withResolvers<ChangeSet>();
    const forget = vi.spyOn(reconciler, 'forget').mockReturnValueOnce(stillThere.promise);
    const sweep = vi.spyOn(reconciler, 'sweep');
    await indexer.start();

    const forgetting = Promise.all([indexer.forget(kept, true), indexer.forget(trashed, true)]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(forget).toHaveBeenCalledOnce();
    expect(sweep).not.toHaveBeenCalled();

    stillThere.resolve({ changed: [], deleted: [] });
    await forgetting;
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toEqual([
      { changed: [], deleted: [trashed] },
      { changed: [], deleted: [vanished] },
    ]);
  });

  it('is idle only once every task has settled, including tasks queued while waiting', async () => {
    const first = Promise.withResolvers<ChangeSet>();
    const second = Promise.withResolvers<ChangeSet>();
    vi.spyOn(reconciler, 'forget')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const forgetting = [indexer.forget(add('a.jpg'), true)];
    let idle = false;
    const waiting = indexer.whenIdle().then(() => {
      idle = true;
    });

    forgetting.push(indexer.forget(add('b.jpg'), true));
    first.resolve({ changed: [], deleted: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);

    second.resolve({ changed: [], deleted: [] });
    await waiting;
    await Promise.all(forgetting);
    await indexer.whenIdle();
  });

  it('tells the reconciler about files moved to the Trash, then reports them gone', async () => {
    const trashed = add('trashed.jpg');
    const expectDeletion = vi.spyOn(reconciler, 'expectDeletion');

    indexer.expectDeletion(trashed);
    expect(expectDeletion).toHaveBeenCalledWith(trashed);
    await indexer.forget(trashed, true);
    expect(reported).toEqual([{ changed: [], deleted: [trashed] }]);
    expect(library.files.pathOf(trashed)).toBeNull();
  });

  it('makes a file that could not be trashed a file like any other at once', async () => {
    const kept = add('kept.jpg');
    const forget = vi.spyOn(reconciler, 'forget');
    const cancelDeletion = vi.spyOn(reconciler, 'cancelDeletion');
    // The queue is busy with something that takes a while.
    const busy = Promise.withResolvers<ChangeSet>();
    vi.spyOn(reconciler, 'sweep').mockReturnValueOnce({ changed: [], deleted: [] });
    forget.mockReturnValueOnce(busy.promise);
    await indexer.start();
    const queued = indexer.forget(add('other.jpg'), true);

    indexer.expectDeletion(kept);
    await indexer.forget(kept, false);

    expect(cancelDeletion).toHaveBeenCalledWith(kept);
    expect(forget).toHaveBeenCalledOnce();
    expect(library.files.pathOf(kept)).not.toBeNull();
    busy.resolve({ changed: [], deleted: [] });
    await queued;
  });
});
