import { createLogger } from '@shared/log';
import watcher from '@parcel/watcher';
import type { FilesRepository } from '../library/files-repository';
import { isInIgnoredDirectory, isIndexable, normalizeRoot, rootsOverlap } from '../library/paths';
import type { RootRecord, RootsRepository } from '../library/roots-repository';
import type { DiskFile } from './crawler';
import { crawl, isDirectory, statFile, statFiles } from './crawler';
import type { ChangeSet, Reconciler } from './reconciler';

const log = createLogger('indexer');

/** How often unreachable roots (unplugged drives, unmounted shares) are checked again. */
const OFFLINE_POLL_MS = 15_000;
/** How often untagged files that vanished, and were not found elsewhere, are forgotten. */
const SWEEP_INTERVAL_MS = 60_000;

/** Native-level filters; everything is filtered again in JS, these only cut event volume. */
const WATCH_IGNORE = ['**/.*', '**/.*/**', '**/node_modules', '**/node_modules/**'];

export interface IndexerListener {
  readonly onChanges: (changes: ChangeSet) => void;
  /** Scanning state or root availability changed. */
  readonly onStateChange: () => void;
}

/**
 * Keeps the index in sync with the library roots: a full scan when a root becomes available, then
 * live updates from the OS file watcher. Roots that cannot be reached are marked offline (their
 * files and tags are kept) and polled until they come back.
 *
 * All index writes go through one serial queue, so scans and watcher batches never interleave.
 */
export class Indexer {
  private readonly roots: RootsRepository;
  private readonly files: FilesRepository;
  private readonly reconciler: Reconciler;
  private readonly listener: IndexerListener;
  private readonly offline = new Set<number>();
  private readonly subscriptions = new Map<number, watcher.AsyncSubscription>();
  private queue: Promise<void> = Promise.resolve();
  private scanningRoot: string | null = null;
  private pollTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    roots: RootsRepository,
    files: FilesRepository,
    reconciler: Reconciler,
    listener: IndexerListener,
  ) {
    this.roots = roots;
    this.files = files;
    this.reconciler = reconciler;
    this.listener = listener;
  }

  get scanning(): string | null {
    return this.scanningRoot;
  }

  get offlineRootIds(): readonly number[] {
    return [...this.offline];
  }

  isOnline(rootId: number): boolean {
    return !this.offline.has(rootId);
  }

  async start(): Promise<void> {
    for (const root of this.roots.list()) {
      await this.activate(root);
    }
    this.pollTimer = setInterval(() => {
      this.pollOffline().catch((error: unknown) => {
        log.error('Offline poll failed:', error);
      });
    }, OFFLINE_POLL_MS);
    this.sweepTimer = setInterval(() => {
      this.schedule(() => this.sweep());
    }, SWEEP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.sweepTimer);
    await Promise.all([...this.subscriptions.keys()].map((id) => this.unwatch(id)));
    await this.queue;
  }

  /** Validates and adds a library root, then indexes it in the background. */
  async addRoot(input: string): Promise<RootRecord> {
    const path = normalizeRoot(input);
    if (!(await isDirectory(path))) {
      throw new Error(`"${path}" is not a folder that can be read.`);
    }
    const clash = this.roots.list().find((root) => rootsOverlap(root.path, path));
    if (clash) {
      throw new Error(
        clash.path === path
          ? `"${path}" is already in the library.`
          : `"${path}" overlaps with "${clash.path}". Library folders cannot be nested.`,
      );
    }
    const root = this.roots.insert(path);
    await this.activate(root);
    return root;
  }

  /** Removes a root and everything indexed under it. Returns the ids of the deleted files. */
  async removeRoot(id: number): Promise<number[]> {
    await this.unwatch(id);
    this.offline.delete(id);
    return this.enqueue(() => {
      const ids = this.files.idsForRoot(id);
      this.roots.delete(id);
      return Promise.resolve(ids);
    });
  }

  /** Resolves once every queued indexing task has settled, including tasks queued meanwhile. */
  async whenIdle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.queue;
      await tail;
    } while (tail !== this.queue);
  }

  /** The app is about to move `id` to the Trash: it must not be taken for a moved file. */
  expectDeletion(id: number): void {
    this.reconciler.expectDeletion(id);
  }

  /**
   * After the app tried to move `id` to the Trash. If it did (`trashed`), drops it, unless it is
   * still on disk. If not, at once, it is a file like any other again: followed if it moves next.
   */
  async forget(id: number, trashed: boolean): Promise<void> {
    if (!trashed) {
      this.reconciler.cancelDeletion(id);
      return;
    }
    this.emit(await this.enqueue(() => this.reconciler.forget(id)));
  }

  private async activate(root: RootRecord): Promise<void> {
    if (await isDirectory(root.path)) {
      this.offline.delete(root.id);
      await this.watch(root);
      this.schedule(() => this.scan(root));
    } else {
      log.warn(`Root offline: ${root.path}`);
      this.offline.add(root.id);
    }
    this.listener.onStateChange();
  }

  private async goOffline(root: RootRecord): Promise<void> {
    log.warn(`Root went offline: ${root.path}`);
    this.offline.add(root.id);
    await this.unwatch(root.id);
    this.listener.onStateChange();
  }

  private async pollOffline(): Promise<void> {
    for (const id of this.offline) {
      const root = this.roots.get(id);
      if (root && !this.stopped && (await isDirectory(root.path))) {
        log.info(`Root back online: ${root.path}`);
        await this.activate(root);
      }
    }
  }

  private async watch(root: RootRecord): Promise<void> {
    if (this.subscriptions.has(root.id)) {
      return;
    }
    try {
      const subscription = await watcher.subscribe(
        root.path,
        (error, events) => {
          if (error) {
            log.warn(`Watcher error on ${root.path}:`, error.message);
            this.schedule(() => this.recheck(root));
            return;
          }
          this.schedule(() => this.applyEvents(root, events));
        },
        { ignore: WATCH_IGNORE },
      );
      this.subscriptions.set(root.id, subscription);
    } catch (error) {
      // The index stays correct as of the last scan; changes show up on the next start.
      log.error(`Cannot watch ${root.path}:`, error);
    }
  }

  private async unwatch(rootId: number): Promise<void> {
    const subscription = this.subscriptions.get(rootId);
    this.subscriptions.delete(rootId);
    await subscription?.unsubscribe().catch((error: unknown) => {
      log.warn('Unsubscribe failed:', error);
    });
  }

  private async scan(root: RootRecord): Promise<void> {
    if (this.stopped || !this.roots.get(root.id)) {
      return;
    }
    this.scanningRoot = root.path;
    this.listener.onStateChange();
    try {
      const started = performance.now();
      const disk = await statFiles(await crawl(root.path));
      // A drive unplugged mid-scan reads as empty: never apply that as "everything was deleted".
      if (!(await isDirectory(root.path))) {
        await this.goOffline(root);
        return;
      }
      const changes = await this.reconciler.syncRoot(root, disk);
      log.info(
        `Scanned ${root.path}: ${disk.length} files, ${changes.changed.length} changed, ` +
          `${changes.deleted.length} removed in ${Math.round(performance.now() - started)} ms`,
      );
      this.emit(changes);
    } finally {
      this.scanningRoot = null;
      this.listener.onStateChange();
    }
  }

  private sweep(): Promise<void> {
    if (!this.stopped) {
      this.emit(this.reconciler.sweep());
    }
    return Promise.resolve();
  }

  private async recheck(root: RootRecord): Promise<void> {
    if (!(await isDirectory(root.path))) {
      await this.goOffline(root);
    }
  }

  private async applyEvents(root: RootRecord, events: readonly watcher.Event[]): Promise<void> {
    if (this.stopped || this.offline.has(root.id) || !this.roots.get(root.id)) {
      return;
    }
    if (!(await isDirectory(root.path))) {
      await this.goOffline(root);
      return;
    }
    // Last event per path wins (create+delete bursts collapse).
    const latest = new Map(events.map((event) => [event.path, event.type] as const));
    const present: DiskFile[] = [];
    const gone: string[] = [];
    for (const [path, type] of latest) {
      if (isInIgnoredDirectory(root.path, path)) {
        continue;
      }
      if (type === 'delete') {
        gone.push(path);
      } else if (await isDirectory(path)) {
        present.push(...(await statFiles(await crawl(path))));
      } else if (isIndexable(path)) {
        const file = await statFile(path);
        if (file) {
          present.push(file);
        } else {
          gone.push(path);
        }
      }
    }
    if (present.length > 0 || gone.length > 0) {
      this.emit(await this.reconciler.applyPaths(root, present, gone));
    }
  }

  private emit(changes: ChangeSet): void {
    if (changes.changed.length > 0 || changes.deleted.length > 0) {
      this.listener.onChanges(changes);
    }
  }

  /** Fire-and-forget variant of `enqueue`; failures are logged by the queue. */
  private schedule(task: () => Promise<void>): void {
    this.enqueue(task).catch(() => undefined);
  }

  /** Runs `task` after every queued task has settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      (error: unknown) => {
        log.error('Indexing task failed:', error);
      },
    );
    return result;
  }
}
