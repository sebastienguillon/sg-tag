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
import type { TagImportKind } from '@shared/model';
import { CatalogueStore } from '../../core/catalogue-store';
import { TagsStore } from '../../core/tags-store';
import { Icon } from '../../ui/icon/icon';
import { TagImportPreview } from './tag-import-preview';
import { importAdditions } from './tag-import-words';
import type { ImportState } from './tag-transfer-store';
import { TagTransferStore } from './tag-transfer-store';

let nextId = 0;

/** What each kind of import is called where a sentence names it. */
const SOURCE_WORDS: Readonly<Record<TagImportKind, string>> = {
  tags: 'tags export',
  tagStudio: 'TagStudio library',
  catalogue: 'catalogue',
};

/** What a sentence asks to import again, after `import`. */
const AGAIN_WORDS: Readonly<Record<TagImportKind, string>> = {
  tags: 'the tags export',
  tagStudio: 'from TagStudio',
  catalogue: 'from the catalogue',
};

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
  private readonly catalogues = inject(CatalogueStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  readonly dataDir = input.required<string | null>();
  /** Tagged files in the library; `null` until known. */
  readonly taggedFiles = input.required<number | null>();
  /** Paths of the library folders that are offline, as far as known. */
  readonly offlineFolders = input<ReadonlySet<string>>(new Set());

  private readonly importButton = viewChild.required<ElementRef<HTMLButtonElement>>('importButton');
  private readonly tagStudioButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('tagStudioButton');
  private readonly catalogueButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('catalogueButton');
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
  protected readonly hintId = `export-hint-${nextId}`;
  /** Ties Import from catalogue… to the reason it cannot import. */
  protected readonly catalogueHintId = `catalogue-hint-${nextId++}`;
  /** Why Import from catalogue… cannot import. */
  protected readonly catalogueHint =
    'To import from a classification catalogue, choose one under Classification catalogue below.';
  /** What the import shown is from: a tags export, a TagStudio library or a catalogue. */
  protected readonly importKind = computed((): TagImportKind => {
    const state = this.store.importState();
    switch (state.step) {
      case 'idle':
        return 'tags';
      case 'opening':
        return state.kind;
      default:
        return state.source?.kind ?? 'tags';
    }
  });
  /** What the import shown is from, as a sentence names it: `the {{ sourceWords }}`. */
  protected readonly sourceWords = computed(() => SOURCE_WORDS[this.importKind()]);
  /** What a sentence asks to import again, after `import`. */
  protected readonly againWords = computed(() => AGAIN_WORDS[this.importKind()]);
  /** A classification catalogue is chosen, and can be read. */
  protected readonly canImportCatalogue = computed(() => {
    const status = this.catalogues.status.hasValue() ? this.catalogues.status.value() : null;
    return status !== null && status.error === null;
  });
  /** What was last imported from: its button gets the focus back. */
  private lastKind: TagImportKind = 'tags';

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

  protected open(kind: TagImportKind): void {
    this.lastKind = kind;
    void this.store.open(kind);
  }

  protected openCatalogue(): void {
    if (this.canImportCatalogue()) {
      this.open('catalogue');
    }
  }

  protected check(): void {
    if (!this.store.busy()) {
      void this.store.check();
    }
  }

  /**
   * Cancel or Escape: the tags export or TagStudio library is closed, and the button that opened
   * it gets the focus.
   */
  protected cancel(): void {
    this.store.cancel();
    this.openButton().focus();
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
   * After the import moved on: a new preview gets the focus, and so does the button that opened it
   * (Import tags… or Import from TagStudio…) once the outcome is known. Either only if the focus is still in this section, or was lost with the
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
          this.openButton().focus();
        }
        break;
      case 'applying':
        break;
      case 'idle':
      case 'opening':
      case 'planning':
        // Check again or Add as library folder went with the preview, say.
        if (lost) {
          this.openButton().focus();
        }
        break;
    }
  }

  /** Import tags…, Import from TagStudio… or Import from catalogue…, whichever was used last. */
  private openButton(): HTMLButtonElement {
    const buttons: Readonly<Record<TagImportKind, () => ElementRef<HTMLButtonElement>>> = {
      tags: this.importButton,
      tagStudio: this.tagStudioButton,
      catalogue: this.catalogueButton,
    };
    return buttons[this.lastKind]().nativeElement;
  }
}
