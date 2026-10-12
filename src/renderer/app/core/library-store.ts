import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { createLogger } from '@shared/log';
import type { FileSummary, IndexStatus, SearchRequest, SearchResult } from '@shared/model';
import { DESKTOP } from './desktop';
import { PreferencesStore } from './preferences-store';
import { WorkerClient } from './worker-client';

const log = createLogger('library');

/** Upper bound of cached tile summaries; the oldest are dropped first. */
const SUMMARY_CACHE_SIZE = 20_000;
const EMPTY_RESULT: SearchResult = { ids: new Int32Array(0), elapsedMs: 0 };

export type SelectMode = 'replace' | 'toggle' | 'range';

/**
 * Search results, tile data and selection for the browser view.
 *
 * Searching is "latest wins": one request in flight at most; keystrokes typed meanwhile collapse
 * into a single follow-up request, and stale results are never displayed.
 */
@Injectable({ providedIn: 'root' })
export class LibraryStore {
  private readonly worker = inject(WorkerClient);
  private readonly desktop = inject(DESKTOP);
  private readonly preferences = inject(PreferencesStore);

  readonly query = signal('');
  private readonly result = signal(EMPTY_RESULT);
  readonly ids = computed(() => this.result().ids);
  readonly elapsedMs = computed(() => this.result().elapsedMs);
  readonly searched = signal(false);
  /** Increments when results for a new query or sort arrive (not on background refreshes). */
  readonly resultsVersion = signal(0);
  readonly status = signal<IndexStatus | null>(null);

  readonly selection = signal<ReadonlySet<number>>(new Set());
  readonly focusedIndex = signal(-1);
  readonly focusedId = computed(() => this.ids()[this.focusedIndex()]);
  /** Item at the top of the grid, so that leaving and re-entering the view keeps the position. */
  scrollAnchor = 0;

  private readonly summaries = new Map<number, FileSummary>();
  private readonly summariesVersion = signal(0);
  /** Cached summaries known to be outdated: still shown, but fetched again when visible. */
  private readonly stale = new Set<number>();
  private readonly requested = new Set<number>();
  private readonly staleVersion = signal(0);

  /** Changes when cached summaries become stale; visible ranges should be re-ensured. */
  readonly invalidated = this.staleVersion.asReadonly();
  private anchorIndex: number | null = null;
  private lastRequestKey = '';
  private inFlight = false;
  private queued: SearchRequest | null = null;

  constructor() {
    effect(() => {
      const request: SearchRequest = { query: this.query(), sort: this.preferences.sort() };
      this.worker.generation();
      untracked(() => {
        this.search(request);
      });
    });
    effect(() => {
      this.worker.generation();
      untracked(() => {
        void this.worker.call('getStatus').then((status) => {
          this.status.set(status);
        });
      });
    });
    this.worker.on('status', (status) => {
      this.status.set(status);
    });
    this.worker.on('filesChanged', ({ ids }) => {
      this.forget(ids);
      this.search({ query: this.query(), sort: this.preferences.sort() });
    });
    this.worker.on('mediaChanged', ({ ids }) => {
      this.forget(ids);
    });
  }

  /** Summary for a tile, if loaded. Reactive: re-evaluates when summaries arrive. */
  summary(id: number): FileSummary | undefined {
    this.summariesVersion();
    return this.summaries.get(id);
  }

  /** Fetches summaries that are not cached, or stale, in one batch. */
  ensureLoaded(ids: Iterable<number>): void {
    const missing: number[] = [];
    for (const id of ids) {
      if ((!this.summaries.has(id) || this.stale.has(id)) && !this.requested.has(id)) {
        this.requested.add(id);
        missing.push(id);
      }
    }
    if (missing.length === 0) {
      return;
    }
    this.worker
      .call('getFiles', missing)
      .then((files) => {
        for (const id of missing) {
          this.stale.delete(id);
          this.summaries.delete(id);
        }
        for (const file of files) {
          this.summaries.set(file.id, file);
        }
        this.trimCache();
        this.summariesVersion.update((version) => version + 1);
      })
      .catch((error: unknown) => {
        log.error('Cannot load files:', error);
      })
      .finally(() => {
        for (const id of missing) {
          this.requested.delete(id);
        }
      });
  }

  select(index: number, mode: SelectMode): void {
    const ids = this.ids();
    const id = ids[index];
    if (id === undefined) {
      return;
    }
    switch (mode) {
      case 'replace':
        this.selection.set(new Set([id]));
        this.anchorIndex = index;
        break;
      case 'toggle': {
        const next = new Set(this.selection());
        if (!next.delete(id)) {
          next.add(id);
        }
        this.selection.set(next);
        this.anchorIndex = index;
        break;
      }
      case 'range': {
        const anchor = this.anchorIndex ?? index;
        this.selection.set(
          new Set(ids.subarray(Math.min(anchor, index), Math.max(anchor, index) + 1)),
        );
        break;
      }
    }
    this.focusedIndex.set(index);
  }

  selectAll(): void {
    this.selection.set(new Set(this.ids()));
  }

  clearSelection(): void {
    this.selection.set(new Set());
    this.anchorIndex = null;
  }

  open(id: number): void {
    this.desktop.openFile(id).catch((error: unknown) => {
      log.error('Cannot open file:', error);
    });
  }

  reveal(id: number): void {
    this.desktop.revealFile(id).catch((error: unknown) => {
      log.error('Cannot reveal file:', error);
    });
  }

  /** Moves a file that has an identical copy to the Trash; rejects with a readable message. */
  async trash(id: number): Promise<void> {
    try {
      await this.desktop.trashFile(id);
    } catch (error) {
      log.warn('Cannot move file to the Trash:', error);
      // Electron prefixes errors thrown in the main process with the channel name.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''), {
        cause: error,
      });
    }
  }

  private search(request: SearchRequest): void {
    if (this.inFlight) {
      this.queued = request;
      return;
    }
    void this.run(request);
  }

  private async run(request: SearchRequest): Promise<void> {
    this.inFlight = true;
    try {
      const result = await this.worker.call('search', request);
      // A newer query is waiting: this result is already stale.
      if (this.queued === null) {
        this.apply(result);
        const key = JSON.stringify(request);
        if (key !== this.lastRequestKey) {
          this.lastRequestKey = key;
          this.resultsVersion.update((version) => version + 1);
        }
      }
    } catch (error) {
      log.error('Search failed:', error);
    } finally {
      this.inFlight = false;
      const next = this.queued;
      this.queued = null;
      if (next) {
        void this.run(next);
      }
    }
  }

  private apply(result: SearchResult): void {
    this.searched.set(true);
    const previous = this.result().ids;
    if (!sameIds(previous, result.ids)) {
      this.anchorIndex = null;
      this.focusedIndex.set(-1);
    }
    this.result.set(sameIds(previous, result.ids) ? { ...result, ids: previous } : result);

    // Keep only selected files that are still listed.
    const selection = this.selection();
    if (selection.size > 0) {
      const kept = new Set<number>();
      for (const id of result.ids) {
        if (selection.has(id)) {
          kept.add(id);
        }
      }
      if (kept.size !== selection.size) {
        this.selection.set(kept);
      }
    }
  }

  /** Marks cached summaries as outdated (`null`: all of them); they refresh when next visible. */
  private forget(ids: readonly number[] | null): void {
    for (const id of ids ?? this.summaries.keys()) {
      if (this.summaries.has(id)) {
        this.stale.add(id);
      }
    }
    this.staleVersion.update((version) => version + 1);
  }

  private trimCache(): void {
    const excess = this.summaries.size - SUMMARY_CACHE_SIZE;
    if (excess <= 0) {
      return;
    }
    let removed = 0;
    for (const id of this.summaries.keys()) {
      if (removed++ >= excess) {
        break;
      }
      this.summaries.delete(id);
      this.stale.delete(id);
    }
  }
}

function sameIds(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}
