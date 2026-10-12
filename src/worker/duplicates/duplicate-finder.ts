import { createLimiter, mapLimit } from '@shared/async';
import type { DuplicateCheck } from '@shared/model';
import { contentHash, fingerprint } from '../indexer/fingerprint';
import type { ContentCandidate, FilesRepository } from '../library/files-repository';

const FINGERPRINT_CONCURRENCY = 4;
const HASH_CONCURRENCY = 2;

export interface DuplicateFinderOptions {
  readonly files: FilesRepository;
  readonly isOnline: (rootId: number) => boolean;
  /** Content hashes were stored among these files: the copies they list may have changed. */
  readonly onHashed: (ids: readonly number[]) => void;
  /** `progress` changed. */
  readonly onProgress: () => void;
}

/**
 * Finds byte-identical files with a funnel where each stage reads more but sees far fewer files:
 * the same size (an index lookup, no reading), then the same fingerprint (first and last 64 KiB),
 * then the same SHA-256 of the whole content, which is only read for the files that passed both.
 *
 * Fingerprints and hashes are stored, and dropped when a file changes, so a check only reads new
 * or changed files. Files on drives that are not connected are skipped. Checks run one at a time.
 */
export class DuplicateFinder {
  private readonly options: DuplicateFinderOptions;
  private readonly serial = createLimiter(1);
  private libraryCheck: Promise<number> | null = null;
  private counts: { done: number; total: number } | null = null;

  constructor(options: DuplicateFinderOptions) {
    this.options = options;
  }

  /** Progress of the library-wide check, `null` when none is running. */
  get progress(): DuplicateCheck | null {
    return this.counts && { ...this.counts };
  }

  /** Checks the whole library; resolves to the number of files that have an identical copy. */
  checkLibrary(): Promise<number> {
    this.libraryCheck ??= this.serial(async () => {
      this.counts = { done: 0, total: 0 };
      this.options.onProgress();
      try {
        await this.confirm(this.options.files.sizeTwins(), null);
        return this.options.files.countWithCopy();
      } finally {
        this.counts = null;
        this.libraryCheck = null;
        this.options.onProgress();
      }
    });
    return this.libraryCheck;
  }

  /** Checks `ids` against the rest of the library, e.g. when they were just tagged. */
  check(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) {
      return Promise.resolve();
    }
    return this.serial(() => this.confirm(this.options.files.sameSizeAs(ids), new Set(ids)));
  }

  /**
   * Reads what is missing to tell which `candidates` are identical. With `targets`, only groups
   * that include one of them are read.
   */
  private async confirm(
    candidates: readonly ContentCandidate[],
    targets: ReadonlySet<number> | null,
  ): Promise<void> {
    const concerned = (group: readonly ContentCandidate[]): boolean =>
      targets === null || group.some((candidate) => targets.has(candidate.id));

    const sameSize = groups(candidates, (candidate) => String(candidate.size))
      .filter(concerned)
      .flat();
    const prints = await this.read(
      sameSize.filter((candidate) => candidate.fingerprint === null),
      FINGERPRINT_CONCURRENCY,
      (candidate) => fingerprint(candidate.path, candidate.size),
      (candidate, print) => {
        this.options.files.setFingerprint(candidate, print);
      },
    );

    const samePrint = groups(sameSize, (candidate) => {
      const print = candidate.fingerprint ?? prints.get(candidate.id);
      return print === undefined ? null : `${String(candidate.size)}:${print}`;
    })
      .filter(concerned)
      .flat();
    const hashes = await this.read(
      samePrint.filter((candidate) => candidate.contentHash === null),
      HASH_CONCURRENCY,
      (candidate) => contentHash(candidate.path),
      (candidate, hash) => {
        this.options.files.setContentHash(candidate, hash);
      },
    );

    if (hashes.size > 0) {
      this.options.onHashed(samePrint.map((candidate) => candidate.id));
    }
  }

  /** Reads `candidates` that are reachable, storing each result; unreadable files are skipped. */
  private async read(
    candidates: readonly ContentCandidate[],
    concurrency: number,
    reader: (candidate: ContentCandidate) => Promise<string>,
    store: (candidate: ContentCandidate, value: string) => void,
  ): Promise<Map<number, string>> {
    const reachable = candidates.filter((candidate) => this.options.isOnline(candidate.rootId));
    this.advance(0, reachable.length);
    const results = new Map<number, string>();
    await mapLimit(reachable, concurrency, async (candidate) => {
      const value = await reader(candidate).catch(() => null);
      if (value !== null) {
        store(candidate, value);
        results.set(candidate.id, value);
      }
      this.advance(1, 0);
    });
    return results;
  }

  private advance(done: number, total: number): void {
    if (this.counts && (done > 0 || total > 0)) {
      this.counts = { done: this.counts.done + done, total: this.counts.total + total };
      this.options.onProgress();
    }
  }
}

/** Groups of two or more items with the same key; items with a `null` key are left out. */
function groups<T>(items: readonly T[], key: (item: T) => string | null): T[][] {
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value !== null) {
      const group = byKey.get(value);
      if (group) {
        group.push(item);
      } else {
        byKey.set(value, [item]);
      }
    }
  }
  return [...byKey.values()].filter((group) => group.length > 1);
}
