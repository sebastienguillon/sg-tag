import {
  Component,
  computed,
  DestroyRef,
  inject,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { createLogger } from '@shared/log';
import type { SortField } from '@shared/model';
import { DEFAULT_SETTINGS, SIDEBAR_WIDTH, TILE_SIZE } from '@shared/model';
import { DESKTOP } from '../core/desktop';
import { LibraryStore } from '../core/library-store';
import { PreferencesStore } from '../core/preferences-store';
import { WorkerClient } from '../core/worker-client';
import { Icon } from '../ui/icon/icon';
import { ResizeHandle } from '../ui/resize-handle/resize-handle';
import { DetailsPanel } from './details-panel/details-panel';
import { FileGrid } from './file-grid/file-grid';
import { SearchBar } from './search-bar/search-bar';
import { StatusBar } from './status-bar/status-bar';

const log = createLogger('browser');

type EmptyState = 'loading' | 'no-folders' | 'indexing' | 'no-files' | 'no-match';

/** The main view: search, thumbnail grid, details sidebar. */
@Component({
  selector: 'app-browser-page',
  imports: [Icon, RouterLink, SearchBar, FileGrid, DetailsPanel, StatusBar, ResizeHandle],
  templateUrl: './browser-page.html',
  styleUrl: './browser-page.css',
  host: { '(document:keydown)': 'onGlobalKeydown($event)' },
})
export class BrowserPage {
  private readonly store = inject(LibraryStore);
  private readonly preferences = inject(PreferencesStore);
  private readonly worker = inject(WorkerClient);
  private readonly desktop = inject(DESKTOP);
  private readonly router = inject(Router);

  private readonly searchBar = viewChild.required(SearchBar);
  private readonly grid = viewChild(FileGrid);
  private readonly details = viewChild(DetailsPanel);
  private readonly rootsRevision = signal(0);
  private readonly isMac = this.desktop.platform === 'darwin';

  protected readonly tileRange = TILE_SIZE;
  protected readonly tileSize = this.preferences.tileSize;
  protected readonly sort = this.preferences.sort;
  protected readonly query = this.store.query;
  protected readonly sidebarOpen = signal(true);
  protected readonly sidebarRange = SIDEBAR_WIDTH;
  protected readonly defaultSidebarWidth = DEFAULT_SETTINGS.sidebarWidth;
  protected readonly sidebarWidth = this.preferences.sidebarWidth;
  protected readonly addError = signal<string | null>(null);

  private readonly roots = resource({
    params: () => ({ connection: this.worker.generation(), revision: this.rootsRevision() }),
    loader: () => this.worker.call('listRoots'),
  });

  protected readonly emptyState = computed<EmptyState | null>(() => {
    if (this.store.ids().length > 0) {
      return null;
    }
    const roots = this.roots.value();
    if (roots === undefined || !this.store.searched()) {
      return 'loading';
    }
    if (roots.length === 0) {
      return 'no-folders';
    }
    if (this.query().trim() !== '') {
      return 'no-match';
    }
    return this.store.status()?.scanning === null ? 'no-files' : 'indexing';
  });

  constructor() {
    const unsubscribe = this.worker.on('rootsChanged', () => {
      this.rootsRevision.update((value) => value + 1);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  protected setTileSize(event: Event): void {
    this.tileSize.set(Number((event.target as HTMLInputElement).value));
  }

  protected setSortField(event: Event): void {
    const field = (event.target as HTMLSelectElement).value as SortField;
    this.sort.update((sort) => ({ ...sort, field }));
  }

  protected toggleSortDirection(): void {
    this.sort.update((sort) => ({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' }));
  }

  protected toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  protected focusGrid(): void {
    this.grid()?.focus();
  }

  protected focusTagInput(): void {
    this.sidebarOpen.set(true);
    // The panel may only now be created.
    queueMicrotask(() => this.details()?.focusTagInput());
  }

  protected async addFolder(): Promise<void> {
    this.addError.set(null);
    const path = await this.desktop.pickFolder();
    if (path === null) {
      return;
    }
    try {
      await this.worker.call('addRoot', path);
    } catch (error) {
      log.warn('Cannot add folder:', error);
      this.addError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected onGlobalKeydown(event: KeyboardEvent): void {
    const modifier = this.isMac ? event.metaKey : event.ctrlKey;
    if (modifier && event.key === 'f') {
      event.preventDefault();
      this.searchBar().focus();
    } else if (modifier && event.key === ',') {
      event.preventDefault();
      void this.router.navigate(['/settings']);
    } else if (event.key === '/' && !isEditable(event.target)) {
      event.preventDefault();
      this.searchBar().focus();
    }
  }
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
