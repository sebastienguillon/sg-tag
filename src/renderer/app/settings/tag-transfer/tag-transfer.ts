import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  input,
  LOCALE_ID,
  untracked,
  viewChild,
} from '@angular/core';
import { TagsStore } from '../../core/tags-store';
import { Icon } from '../../ui/icon/icon';
import { TagImportPreview } from './tag-import-preview';
import { importAdditions } from './tag-import-words';
import type { ImportState } from './tag-transfer-store';
import { TagTransferStore } from './tag-transfer-store';

let nextId = 0;

/** The Tags section of Settings: where tags are kept, exporting them, and importing a tags export. */
@Component({
  selector: 'app-tag-transfer',
  imports: [Icon, TagImportPreview, DatePipe, DecimalPipe, PercentPipe],
  templateUrl: './tag-transfer.html',
  styleUrl: './tag-transfer.css',
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class TagTransfer {
  protected readonly store = inject(TagTransferStore);
  private readonly tagsStore = inject(TagsStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  readonly dataDir = input.required<string | null>();
  /** Tagged files in the library; `null` until known. */
  readonly taggedFiles = input.required<number | null>();
  /** Paths of the library folders that are offline, as far as known. */
  readonly offlineFolders = input<ReadonlySet<string>>(new Set());

  private readonly importButton = viewChild.required<ElementRef<HTMLButtonElement>>('importButton');
  private readonly preview = viewChild(TagImportPreview);

  protected readonly tagCount = computed(() => this.tagsStore.tags().length);
  /**
   * There is no tag to export, as far as known. A tag made on purpose is exported without a file,
   * and a tagged file has a tag even before the tags are listed.
   */
  protected readonly noTag = computed(
    () => this.taggedFiles() === 0 && this.tagsStore.loaded() && this.tagCount() === 0,
  );
  /** What the import that ended added, as a sentence; empty when it added nothing. */
  protected readonly added = computed(() => {
    const state = this.store.importState();
    if (state.step !== 'done') {
      return '';
    }
    const { assignments, files, newTags, definitions } = state.result;
    const text = importAdditions(
      {
        assignments,
        files,
        newTags: definitions.created + newTags,
        aliases: definitions.aliases,
        links: definitions.links,
      },
      'past',
      this.locale,
    );
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  });
  /** Ties Export tags… to the reason it cannot export. */
  protected readonly hintId = `export-hint-${nextId++}`;

  constructor() {
    let shown: ImportState | null = null;
    // What the open dialog replaced: it is back as it was when the dialog is canceled.
    let replaced: ImportState | null = null;
    afterRenderEffect(() => {
      const state = this.store.importState();
      if (shown !== null && state !== shown) {
        const restored = state === replaced;
        replaced = state.step === 'opening' ? shown : null;
        if (!restored) {
          untracked(() => {
            this.placeFocus(state);
          });
        }
      }
      shown = state;
    });
    // Settings is shown (again), and says how the export and the import ended.
    this.store.show();
    // Leaving Settings closes the tags export being previewed; an export or an import goes on.
    inject(DestroyRef).onDestroy(() => {
      this.store.leave();
    });
  }

  protected export(): void {
    if (!this.noTag()) {
      void this.store.export();
    }
  }

  protected open(): void {
    void this.store.open();
  }

  protected check(): void {
    if (!this.store.busy()) {
      void this.store.check();
    }
  }

  /** Cancel or Escape: the tags export is closed, and Import tags… gets the focus. */
  protected cancel(): void {
    this.store.cancel();
    this.importButton().nativeElement.focus();
  }

  protected onEscape(event: Event): void {
    const applying = this.store.importState().step === 'applying';
    if (!applying && !this.store.cancelable()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Once under way, the import finishes anyway: closing would say otherwise.
    if (!applying) {
      this.cancel();
    }
  }

  /**
   * After the import moved on: a new preview gets the focus, and so does Import tags… once the
   * outcome is known. Either only if the focus is still in this section, or was lost with the
   * control that had it: the user may have gone elsewhere in the meantime.
   */
  private placeFocus(state: ImportState): void {
    const active = this.document.activeElement;
    const lost = active === null || active === this.document.body;
    const here = lost || this.host.nativeElement.contains(active);
    switch (state.step) {
      case 'preview':
        if (here) {
          this.preview()?.focus();
        }
        break;
      case 'done':
      case 'error':
        if (here) {
          this.importButton().nativeElement.focus();
        }
        break;
      case 'applying':
        break;
      case 'idle':
      case 'opening':
      case 'planning':
        // Check again or Add as library folder went with the preview, say.
        if (lost) {
          this.importButton().nativeElement.focus();
        }
        break;
    }
  }
}
