import type { FilesRepository, FingerprintTarget } from '../library/files-repository';
import { WorkPool } from '../thumbnails/work-pool';
import { fingerprint } from './fingerprint';

const BACKGROUND_BATCH = 64;

export interface FingerprinterOptions {
  readonly files: FilesRepository;
  readonly offlineRootIds: () => readonly number[];
}

/**
 * Gives every file a content fingerprint, so that it is recognised after a move to another drive
 * (once it has vanished, it can no longer be read) and can be compared when looking for duplicates.
 *
 * Tagged files are fingerprinted as soon as they are tagged or change. The others follow in the
 * background, newest first once their thumbnail is done: the thumbnailer has just read them, so
 * the 128 KiB needed are usually still in the OS cache.
 */
export class Fingerprinter {
  private readonly options: FingerprinterOptions;
  private readonly pool: WorkPool<FingerprintTarget>;
  private readonly inflight = new Set<number>();
  /** Unreadable files, left alone until they change. */
  private readonly failed = new Set<number>();
  private backgroundEnabled = false;

  constructor(options: FingerprinterOptions) {
    this.options = options;
    this.pool = new WorkPool<FingerprintTarget>({
      concurrency: 2,
      reserved: 1,
      run: (target) => this.run(target),
      refill: () => this.refill(),
    });
  }

  /** Fingerprints the tagged files among `ids` that have none, ahead of background work. */
  prioritize(ids: readonly number[]): void {
    if (ids.length === 0) {
      return;
    }
    for (const target of this.options.files.needingFingerprint(ids)) {
      if (!this.inflight.has(target.id)) {
        this.inflight.add(target.id);
        this.pool.pushUrgent(target);
      }
    }
  }

  startBackground(): void {
    this.backgroundEnabled = true;
    this.pool.kick();
  }

  /** Files were indexed, changed (`changed` are tried again if they failed) or got thumbnails. */
  wake(changed: readonly number[] = []): void {
    for (const id of changed) {
      this.failed.delete(id);
    }
    if (this.backgroundEnabled) {
      this.pool.kick();
    }
  }

  /** A drive came back: files that could not be read may be readable now. */
  retryFailed(): void {
    this.failed.clear();
    this.wake();
  }

  stop(): void {
    this.backgroundEnabled = false;
  }

  private refill(): FingerprintTarget[] {
    if (!this.backgroundEnabled) {
      return [];
    }
    const targets = this.options.files.unfingerprinted(
      this.options.offlineRootIds(),
      [...this.inflight, ...this.failed],
      BACKGROUND_BATCH,
    );
    for (const target of targets) {
      this.inflight.add(target.id);
    }
    return targets;
  }

  private async run(target: FingerprintTarget): Promise<void> {
    let moved = false;
    try {
      this.options.files.setFingerprint(target, await fingerprint(target.path, target.size));
    } catch {
      // A target keeps the path it was queued with: the file may have been renamed since.
      moved = this.options.files.pathOf(target.id) !== target.path;
      if (!moved) {
        this.failed.add(target.id);
      }
    } finally {
      this.inflight.delete(target.id);
    }
    if (moved) {
      // Read it where it is now (ahead of background work if tagged).
      this.prioritize([target.id]);
      this.wake();
    }
  }
}
