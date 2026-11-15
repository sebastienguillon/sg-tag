import {
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualScrollViewport,
} from '@angular/cdk/scrolling';
import { DecimalPipe, formatNumber } from '@angular/common';
import type { ElementRef } from '@angular/core';
import {
  afterNextRender,
  afterRenderEffect,
  Component,
  computed,
  inject,
  Injector,
  LOCALE_ID,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { createLogger } from '@shared/log';
import type { Tag, TagRef } from '@shared/model';
import { describeTagNameProblem, normalizeTagName } from '@shared/tag-names';
import { TagEditor } from '../browser/tag-editor/tag-editor';
import { counted, describeTagEditError } from '../browser/tag-editor/tag-edit-words';
import { ipcErrorMessage } from '../core/desktop';
import { LibraryStore } from '../core/library-store';
import { TagsStore } from '../core/tags-store';
import { WorkerClient } from '../core/worker-client';
import { Icon } from '../ui/icon/icon';
import { countTagsBelow } from './tags-below';

const log = createLogger('tags');

/** The height of a row of the list, in pixels: the virtual scroll's item size, and the CSS one. */
const ROW_HEIGHT = 32;

/** A tag as the list shows it. */
interface TagRow {
  readonly tag: Tag;
  /** The names of its parent tags, in the order of names. */
  readonly parents: string;
  /** How many tags are below it, at any depth, each counted once. */
  readonly below: number;
}

/** Why the name typed for a new tag made none. */
interface CreateRefusal {
  readonly message: string;
  /** The tag that has the name, offered to be edited instead. */
  readonly owner: TagRef | null;
}

/**
 * Every tag of the library in one list, sorted by name, and the tag editor of the tag selected
 * beside it. The list is virtualised: only the rows on screen exist, so 20,000 tags cost the same
 * as 20.
 *
 * The list is one tab stop, an ARIA listbox: the arrows move the selection, and the editor follows
 * it without taking the focus; Enter goes into the editor, and Escape in the editor comes back to
 * the list, on the same tag.
 */
@Component({
  selector: 'app-tags-page',
  imports: [
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    DecimalPipe,
    Icon,
    RouterLink,
    TagEditor,
  ],
  templateUrl: './tags-page.html',
  styleUrl: './tags-page.css',
})
export class TagsPage {
  private readonly tags = inject(TagsStore);
  private readonly library = inject(LibraryStore);
  private readonly worker = inject(WorkerClient);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);

  private readonly viewport = viewChild.required(CdkVirtualScrollViewport);
  private readonly filterField = viewChild.required<ElementRef<HTMLInputElement>>('filterField');
  private readonly newTagField = viewChild<ElementRef<HTMLInputElement>>('newTagField');
  private readonly newTagButton = viewChild.required<ElementRef<HTMLButtonElement>>('newTagButton');
  private readonly editor = viewChild(TagEditor);

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly loaded = this.tags.loaded;
  protected readonly empty = computed(() => this.tags.loaded() && this.tags.tags().length === 0);

  protected readonly filterText = signal('');
  /** Only the tags no file has. */
  protected readonly unusedOnly = signal(false);
  /** Only the tags without a parent tag. */
  protected readonly withoutParentOnly = signal(false);
  /** The tags whose name or an alias holds the text typed; `null` when it keeps them all. */
  private readonly holding = computed(() => this.tags.holding(this.filterText()));
  private readonly filtered = computed(
    () => this.holding() !== null || this.unusedOnly() || this.withoutParentOnly(),
  );

  /** Every tag, in the order the worker sorts names, with what its row says of it. */
  private readonly allRows = computed<readonly TagRow[]>(() => {
    const tags = this.tags.tags();
    const byId = this.tags.byId();
    const below = countTagsBelow(tags);
    return tags.map((tag) => ({
      tag,
      parents: tag.parentIds.flatMap((id) => byId.get(id)?.name ?? []).join(', '),
      below: below.get(tag.id) ?? 0,
    }));
  });
  /** The tags shown: those the filters keep, still in the order of names. */
  protected readonly rows = computed<readonly TagRow[]>(() => {
    const all = this.allRows();
    if (!this.filtered()) {
      return all;
    }
    const holding = this.holding();
    const unused = this.unusedOnly();
    const withoutParent = this.withoutParentOnly();
    return all.filter(
      ({ tag }) =>
        (holding === null || holding.has(tag.id)) &&
        (!unused || tag.fileCount === 0) &&
        (!withoutParent || tag.parentIds.length === 0),
    );
  });
  private readonly places = computed(
    () => new Map(this.rows().map((row, index) => [row.tag.id, index])),
  );
  /** `340 tags`, or how many of them are shown: `12 of 340 tags`. Nothing until they are listed. */
  protected readonly countText = computed(() => {
    if (!this.tags.loaded()) {
      return '';
    }
    const total = counted(this.tags.tags().length, 'tag', 'tags', this.locale);
    return this.filtered() ? `${formatNumber(this.rows().length, this.locale)} of ${total}` : total;
  });

  /**
   * The tag the editor shows. It stays selected when the filters hide it, or when it no longer
   * exists: the editor then says so.
   */
  protected readonly selectedId = signal<number | null>(null);
  /** Where the selected tag is in the list; -1 when it is not shown. */
  private readonly selectedIndex = computed(() => {
    const id = this.selectedId();
    return id === null ? -1 : (this.places().get(id) ?? -1);
  });
  protected readonly activeDescendant = computed(() => {
    const id = this.selectedId();
    return id !== null && this.selectedIndex() >= 0 ? this.rowId(id) : null;
  });

  /** New tag: the field that asks for its name is open. */
  protected readonly creating = signal(false);
  protected readonly newName = signal('');
  protected readonly createRefusal = signal<CreateRefusal | null>(null);
  /** The new tag is being made: Enter again makes no second one. */
  private makingTag = false;

  constructor() {
    // The arrival is to find a tag: the filter box takes the focus.
    afterNextRender(() => {
      this.filterField().nativeElement.focus();
    });
    // The selected row stays in view: moved to by the keyboard, renamed to another place, made by
    // New tag, or shown again once the filters let it through.
    afterRenderEffect({
      write: () => {
        const index = this.selectedIndex();
        if (index >= 0) {
          this.scrollIntoView(index);
        }
      },
    });
  }

  protected rowId(id: number): string {
    return `tag-row-${id}`;
  }

  protected trackById(_index: number, row: TagRow): number {
    return row.tag.id;
  }

  protected onFilterInput(event: Event): void {
    this.filterText.set((event.target as HTMLInputElement).value);
  }

  /** ↓ or Enter goes on to the list; Escape empties the box, then goes back to the library. */
  protected onFilterKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      this.enterList();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.filterText() === '') {
        this.backToLibrary();
      } else {
        this.filterText.set('');
      }
    }
  }

  protected toggleUnused(): void {
    this.unusedOnly.update((on) => !on);
  }

  protected toggleWithoutParent(): void {
    this.withoutParentOnly.update((on) => !on);
  }

  protected onListKeydown(event: KeyboardEvent): void {
    const count = this.rows().length;
    const current = this.selectedIndex();
    let target: number;
    switch (event.key) {
      case 'ArrowDown':
        target = current + 1;
        break;
      case 'ArrowUp':
        target = current - 1;
        break;
      case 'PageDown':
        target = current + this.pageSize();
        break;
      case 'PageUp':
        target = current - this.pageSize();
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = count - 1;
        break;
      case 'Enter':
        event.preventDefault();
        this.focusEditor();
        return;
      case 'Escape':
        event.preventDefault();
        this.backToLibrary();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (count === 0) {
      return;
    }
    // No tag shown is selected yet: the first key starts from the top, but End.
    const index = current < 0 && event.key !== 'End' ? 0 : Math.min(count - 1, Math.max(0, target));
    this.selectAt(index);
  }

  protected onListClick(event: MouseEvent): void {
    const row = event.target instanceof Element ? event.target.closest('[data-index]') : null;
    const index = row instanceof HTMLElement ? Number(row.dataset['index']) : Number.NaN;
    if (!Number.isNaN(index)) {
      this.selectAt(index);
    }
  }

  /** Escape in the editor: the focus comes back to the list, on the same tag. */
  protected onEditorClosed(): void {
    this.focusList();
  }

  /** Merging the tag into another: the selection follows the tag kept. */
  protected onEditorTagChange(id: number): void {
    this.selectedId.set(id);
  }

  /**
   * The tag was deleted: the tag after it in the list takes its place, or the one before it when
   * it was the last, and the list takes the focus that the editor had. The list still holds the
   * deleted tag until it is read again.
   */
  protected onDeleted(): void {
    const index = this.selectedIndex();
    const rows = this.rows();
    const next = index < 0 ? undefined : (rows[index + 1] ?? rows[index - 1]);
    this.selectedId.set(next?.tag.id ?? null);
    this.focusList();
  }

  /** A parent or child tag clicked in the editor: the library lists its files. */
  protected search(query: string): void {
    this.library.query.set(query);
    this.backToLibrary();
  }

  /** New tag, in the header of the list: opens the field that asks for its name, or closes it. */
  protected toggleNewTag(): void {
    if (this.creating()) {
      this.closeNewTag();
    } else {
      this.openNewTag();
    }
  }

  /** Opens the field that asks for the name of a new tag, and puts the focus in it. */
  protected openNewTag(): void {
    this.creating.set(true);
    afterNextRender(
      () => {
        this.newTagField()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected onNewNameInput(event: Event): void {
    this.newName.set((event.target as HTMLInputElement).value);
    this.createRefusal.set(null);
  }

  /** Enter makes the tag; Escape empties the field, then closes it. */
  protected onNewNameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.createTag();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.newName() === '') {
        this.closeNewTag();
      } else {
        this.newName.set('');
        this.createRefusal.set(null);
      }
    }
  }

  /**
   * Selects tag `id` and puts the focus in its editor, the field of New tag closed: the tag made,
   * or the tag that has the name typed.
   */
  protected editTag(id: number): void {
    this.creating.set(false);
    this.newName.set('');
    this.createRefusal.set(null);
    this.selectedId.set(id);
    this.focusEditor();
  }

  private async createTag(): Promise<void> {
    if (this.makingTag) {
      return;
    }
    const typed = this.newName();
    // Nothing typed is no name to refuse: the field loses its spaces, without a word.
    if (typed.trim() === '') {
      this.newName.set('');
      return;
    }
    const check = normalizeTagName(typed);
    if (!check.ok) {
      // The text stays where it can be corrected.
      this.createRefusal.set({ message: describeTagNameProblem(check.problem), owner: null });
      return;
    }
    this.makingTag = true;
    try {
      const result = await this.worker.call('createTag', check.name);
      if (result.ok) {
        this.editTag(result.tag.id);
        return;
      }
      const error = result.error;
      this.createRefusal.set({
        message: describeTagEditError(error, check.name, this.locale),
        owner: error.kind === 'taken' ? error.owner : null,
      });
    } catch (error) {
      log.error('Cannot create tag:', error);
      this.createRefusal.set({
        message: `The tag could not be made: ${ipcErrorMessage(error)}`,
        owner: null,
      });
    } finally {
      this.makingTag = false;
    }
  }

  private closeNewTag(): void {
    this.creating.set(false);
    this.newName.set('');
    this.createRefusal.set(null);
    this.newTagButton().nativeElement.focus();
  }

  private selectAt(index: number): void {
    const row = this.rows()[index];
    if (row) {
      this.selectedId.set(row.tag.id);
    }
  }

  /** ↓ from the filter box: the list takes the focus, on the first tag when none shown is selected. */
  private enterList(): void {
    if (this.selectedIndex() < 0) {
      this.selectAt(0);
    }
    this.focusList();
  }

  private focusList(): void {
    this.viewport().elementRef.nativeElement.focus();
  }

  /** The name field of the editor takes the focus, once the editor shows the tag selected. */
  private focusEditor(): void {
    if (this.selectedId() === null) {
      return;
    }
    // The editor may only be made by this change, and it reads the tag before showing it.
    afterNextRender(
      () => {
        this.editor()?.focus();
      },
      { injector: this.injector },
    );
  }

  private backToLibrary(): void {
    void this.router.navigate(['/']);
  }

  /** How many rows PageUp and PageDown move: a screen of them, less one, as the grid does. */
  private pageSize(): number {
    const height = this.viewport().elementRef.nativeElement.clientHeight;
    return Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
  }

  /** Scrolls the least needed to bring the row at `index` fully into view. */
  private scrollIntoView(index: number): void {
    const viewport = this.viewport();
    const height = viewport.elementRef.nativeElement.clientHeight;
    // Not laid out: nothing is on screen to scroll to.
    if (height === 0) {
      return;
    }
    const top = index * ROW_HEIGHT;
    const scrollTop = viewport.measureScrollOffset('top');
    if (top < scrollTop) {
      viewport.scrollToOffset(top);
    } else if (top + ROW_HEIGHT > scrollTop + height) {
      viewport.scrollToOffset(top + ROW_HEIGHT - height);
    }
  }
}
