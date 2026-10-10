import {
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualScrollViewport,
} from '@angular/cdk/scrolling';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DESKTOP } from '../../core/desktop';
import type { SelectMode } from '../../core/library-store';
import { LibraryStore } from '../../core/library-store';
import { PreferencesStore } from '../../core/preferences-store';
import { FileTile } from '../file-tile/file-tile';
import { computeGridLayout } from '../grid-layout';
import { RowIdsPipe } from './row-ids-pipe';

const GAP = 8;
const PADDING = 12;

/**
 * Virtualised thumbnail grid. CDK virtual scrolling works on rows of fixed height; each row lays
 * out `columns` tiles. Only visible rows (plus a small buffer) exist in the DOM, and only their
 * files are fetched, so 100k results cost the same as 100.
 *
 * Interaction is delegated to the scroll viewport (one listener instead of one per tile), which is
 * also the ARIA listbox that keeps keyboard focus.
 */
@Component({
  selector: 'app-file-grid',
  imports: [
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    FileTile,
    RowIdsPipe,
  ],
  templateUrl: './file-grid.html',
  styleUrl: './file-grid.css',
  host: {
    '[style.--columns]': 'layout().columns',
    '[style.--tile-size.px]': 'layout().tileSize',
    '[style.--gap.px]': 'gap',
    '[style.--padding.px]': 'padding',
  },
})
export class FileGrid {
  private readonly store = inject(LibraryStore);
  private readonly preferences = inject(PreferencesStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isMac = inject(DESKTOP).platform === 'darwin';

  /** The user pressed T: move focus to the tag editor. */
  readonly tagRequested = output();

  private readonly viewport = viewChild.required(CdkVirtualScrollViewport);
  private readonly width = signal(0);
  private readonly height = signal(0);
  private readonly firstRow = signal(0);

  protected readonly gap = GAP;
  protected readonly padding = PADDING;
  protected readonly ids = this.store.ids;
  protected readonly selection = this.store.selection;
  protected readonly focusedId = this.store.focusedId;
  protected readonly layout = computed(() =>
    computeGridLayout({
      width: this.width(),
      targetTileSize: this.preferences.tileSize(),
      gap: GAP,
      padding: PADDING,
      itemCount: this.ids().length,
    }),
  );
  protected readonly rows = computed(() =>
    Array.from({ length: this.layout().rowCount }, (_, row) => row),
  );
  protected readonly activeDescendant = computed(() => {
    const id = this.focusedId();
    return id === undefined ? null : `file-${id}`;
  });
  private readonly visibleRows = computed(() =>
    Math.max(1, Math.ceil(this.height() / this.layout().rowHeight)),
  );

  constructor() {
    afterNextRender(() => {
      const element = this.viewport().elementRef.nativeElement;
      const observer = new ResizeObserver(() => {
        this.width.set(element.clientWidth);
        this.height.set(element.clientHeight);
        this.viewport().checkViewportSize();
      });
      observer.observe(element);
      this.destroyRef.onDestroy(() => {
        observer.disconnect();
      });
    });

    // Fetch tile data for the visible rows, one screen behind and one ahead.
    effect(() => {
      const { columns } = this.layout();
      const screen = this.visibleRows();
      const start = Math.max(0, this.firstRow() - screen) * columns;
      const end = (this.firstRow() + 2 * screen + 1) * columns;
      const ids = this.ids();
      this.store.invalidated();
      untracked(() => {
        this.store.ensureLoaded(ids.subarray(start, end));
      });
    });

    // Keep the first visible item in place when the column count changes, and restore the
    // position from the previous visit once the grid has been measured.
    let columns = 0;
    effect(() => {
      const next = this.layout().columns;
      if (this.width() === 0 || next === columns) {
        return;
      }
      columns = next;
      untracked(() => {
        this.viewport().scrollToIndex(Math.floor(this.store.scrollAnchor / next));
      });
    });

    // New query or sort: start from the top.
    let version = this.store.resultsVersion();
    effect(() => {
      const next = this.store.resultsVersion();
      if (next !== version) {
        version = next;
        untracked(() => {
          this.viewport().scrollToOffset(0);
        });
      }
    });
  }

  focus(): void {
    this.viewport().elementRef.nativeElement.focus();
    if (this.store.focusedIndex() < 0 && this.ids().length > 0) {
      this.store.select(Math.floor(this.store.scrollAnchor), 'replace');
    }
  }

  protected onScrolled(row: number): void {
    this.firstRow.set(row);
    this.store.scrollAnchor = row * this.layout().columns;
  }

  protected onClick(event: MouseEvent): void {
    const index = tileIndex(event.target);
    if (index !== null) {
      this.store.select(index, this.selectMode(event));
    } else if (!event.shiftKey && !this.hasModifier(event)) {
      this.store.clearSelection();
    }
  }

  protected onDoubleClick(event: MouseEvent): void {
    const index = tileIndex(event.target);
    const id = index === null ? undefined : this.ids()[index];
    if (id !== undefined) {
      this.store.open(id);
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.ids().length;
    if (count === 0) {
      return;
    }
    const { columns } = this.layout();
    const current = this.store.focusedIndex();
    const page = Math.max(1, this.visibleRows() - 1) * columns;
    let target: number;
    switch (event.key) {
      case 'ArrowRight':
        target = current + 1;
        break;
      case 'ArrowLeft':
        target = current - 1;
        break;
      case 'ArrowDown':
        target = current + columns;
        break;
      case 'ArrowUp':
        target = current - columns;
        break;
      case 'PageDown':
        target = current + page;
        break;
      case 'PageUp':
        target = current - page;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = count - 1;
        break;
      default:
        this.onCommandKey(event);
        return;
    }
    event.preventDefault();
    const index = current < 0 ? 0 : Math.min(count - 1, Math.max(0, target));
    this.store.select(index, event.shiftKey ? 'range' : 'replace');
    this.scrollIntoView(index);
  }

  private onCommandKey(event: KeyboardEvent): void {
    const focusedId = this.store.focusedId();
    switch (event.key) {
      case 'Enter':
        if (focusedId !== undefined) {
          this.store.open(focusedId);
        }
        break;
      case ' ':
        if (this.store.focusedIndex() >= 0) {
          this.store.select(this.store.focusedIndex(), 'toggle');
        }
        break;
      case 'Escape':
        this.store.clearSelection();
        break;
      case 'a':
        if (!this.hasModifier(event)) {
          return;
        }
        this.store.selectAll();
        break;
      case 't':
        if (this.hasModifier(event) || this.selection().size === 0) {
          return;
        }
        this.tagRequested.emit();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** Scrolls the least needed to bring the row of `index` fully into view. */
  private scrollIntoView(index: number): void {
    const { rowHeight, columns } = this.layout();
    const viewport = this.viewport();
    const top = Math.floor(index / columns) * rowHeight;
    const scrollTop = viewport.measureScrollOffset('top');
    const height = this.height();
    if (top < scrollTop) {
      viewport.scrollToOffset(top);
    } else if (top + rowHeight > scrollTop + height) {
      viewport.scrollToOffset(top + rowHeight - height);
    }
  }

  private selectMode(event: MouseEvent): SelectMode {
    if (event.shiftKey) {
      return 'range';
    }
    return this.hasModifier(event) ? 'toggle' : 'replace';
  }

  /** ⌘ on macOS, Ctrl elsewhere. */
  private hasModifier(event: MouseEvent | KeyboardEvent): boolean {
    return this.isMac ? event.metaKey : event.ctrlKey;
  }
}

function tileIndex(target: EventTarget | null): number | null {
  const tile = target instanceof Element ? target.closest<HTMLElement>('[data-index]') : null;
  const index = tile?.dataset['index'];
  return index === undefined ? null : Number(index);
}
