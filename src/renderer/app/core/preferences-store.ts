import { effect, inject, Injectable, signal } from '@angular/core';
import type { SortOrder } from '@shared/model';
import { DEFAULT_SETTINGS } from '@shared/model';
import { WorkerClient } from './worker-client';

/** Startup never waits longer than this for stored preferences. */
const LOAD_TIMEOUT_MS = 2_000;
const SAVE_DELAY_MS = 400;

/** User preferences, stored by the indexer so they live next to the library they describe. */
@Injectable({ providedIn: 'root' })
export class PreferencesStore {
  private readonly worker = inject(WorkerClient);
  private readonly loaded = signal(false);

  readonly tileSize = signal(DEFAULT_SETTINGS.tileSize);
  readonly sort = signal<SortOrder>(DEFAULT_SETTINGS.sort);
  readonly sidebarWidth = signal(DEFAULT_SETTINGS.sidebarWidth);

  constructor() {
    // Persist changes, debounced (the size slider and sidebar splitter fire continuously).
    effect((onCleanup) => {
      const patch = {
        tileSize: this.tileSize(),
        sort: this.sort(),
        sidebarWidth: this.sidebarWidth(),
      };
      if (!this.loaded()) {
        return;
      }
      const timer = setTimeout(() => {
        void this.worker.call('updateSettings', patch);
      }, SAVE_DELAY_MS);
      onCleanup(() => {
        clearTimeout(timer);
      });
    });
  }

  /** Loads stored preferences; used as an app initializer so the first render is final. */
  async load(): Promise<void> {
    const timeout = new Promise<null>((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS, null));
    const settings = await Promise.race([this.worker.call('getSettings'), timeout]).catch(
      () => null,
    );
    if (settings) {
      this.tileSize.set(settings.tileSize);
      this.sort.set(settings.sort);
      this.sidebarWidth.set(settings.sidebarWidth);
    }
    this.loaded.set(true);
  }
}
