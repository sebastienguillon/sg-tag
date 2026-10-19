import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, input, linkedSignal, viewChild } from '@angular/core';
import type { ElementRef } from '@angular/core';
import type {
  TagImportMissReason,
  TagImportPreview as Preview,
  TagImportSource,
} from '@shared/model';
import { ipcErrorMessage } from '../../core/desktop';
import { Icon } from '../../ui/icon/icon';
import { TagTransferStore } from './tag-transfer-store';

/** A map, not an object: a platform named after an `Object.prototype` member gets no label. */
const PLATFORM_LABELS: ReadonlyMap<string, string> = new Map([
  ['darwin', 'a Mac'],
  ['win32', 'a Windows PC'],
  ['linux', 'a Linux computer'],
]);

const REASON_LABELS: Readonly<Record<TagImportMissReason, string>> = {
  missing: 'missing when exported',
  uncompared: 'drive not connected or unreadable',
  folder: 'folder not in this library',
  notFound: 'not found',
};

/** Why a library folder could not be added. */
interface AddError {
  readonly folder: string;
  readonly message: string;
}

let nextId = 0;

/** What importing a tags export would add, and where its files were found, before importing it. */
@Component({
  selector: 'app-tag-import-preview',
  imports: [Icon, DatePipe, DecimalPipe],
  templateUrl: './tag-import-preview.html',
  styleUrl: './tag-import-preview.css',
  host: { role: 'group', '[attr.aria-labelledby]': 'headingId' },
})
export class TagImportPreview {
  private readonly store = inject(TagTransferStore);

  readonly source = input.required<TagImportSource>();
  readonly preview = input.required<Preview>();
  /** Paths of the library folders that are offline, as far as known. */
  readonly offlineFolders = input<ReadonlySet<string>>(new Set());

  private readonly primaryButton = viewChild<ElementRef<HTMLButtonElement>>('primary');

  protected readonly headingId = `tag-import-heading-${nextId}`;
  /** Ties the button that imports or closes to what importing would add. */
  protected readonly summaryId = `tag-import-summary-${nextId++}`;
  protected readonly reasonLabels = REASON_LABELS;
  /** The import is under way, an export, or a library folder is being added: nothing can start. */
  protected readonly locked = this.store.busy;
  protected readonly applying = computed(() => this.store.importState().step === 'applying');
  /** Kept by the store, so that the preview is back as it was after the open dialog is canceled. */
  protected readonly includeChanged = this.store.includeChanged;
  protected readonly adding = this.store.adding;
  protected readonly addError = linkedSignal<Preview, AddError | null>({
    source: this.preview,
    computation: () => null,
  });

  /** When the tags export was made, if it says so in a form that can be read. */
  protected readonly exportedAt = computed(() => {
    const time = Date.parse(this.source().exportedAt ?? '');
    return Number.isNaN(time) ? null : time;
  });
  protected readonly exportedFrom = computed(() => {
    const platform = this.source().platform;
    return platform === null ? null : (PLATFORM_LABELS.get(platform) ?? null);
  });
  protected readonly found = computed(() => {
    const { samePlace, moved, shared } = this.preview().found;
    return samePlace + moved + shared;
  });
  protected readonly notFound = computed(() => {
    const { missing, uncompared, folder, notFound } = this.preview().notFound;
    return missing + uncompared + folder + notFound;
  });
  protected readonly nothingFound = computed(
    () => this.found() === 0 && this.preview().changed === 0,
  );
  protected readonly additions = computed(() =>
    this.includeChanged() ? this.preview().additionsWithChanged : this.preview().additions,
  );
  /** Nothing found or nothing to add: Close is the only way on. */
  protected readonly canImport = computed(
    () => !this.nothingFound() && this.additions().assignments > 0,
  );
  /** Where the files were found is worth showing only when it is not plainly where they were. */
  protected readonly showFolders = computed(() => {
    const folders = this.preview().folders;
    return (
      folders.length > 1 ||
      folders.some((folder) => folder.foundIn[0] !== folder.exported) ||
      this.notFound() > 0
    );
  });

  /** Focuses the button that imports, or Close when it is the only way on. */
  focus(): void {
    this.primaryButton()?.nativeElement.focus();
  }

  /** While locked, the checkbox only looks disabled, to keep the focus: clicks must not change it. */
  protected guardChanged(event: Event): void {
    if (this.locked()) {
      event.preventDefault();
    }
  }

  protected check(): void {
    if (!this.locked()) {
      void this.store.check();
    }
  }

  protected async addFolder(path: string): Promise<void> {
    if (this.locked()) {
      return;
    }
    this.addError.set(null);
    try {
      await this.store.addFolder(path);
    } catch (error) {
      this.addError.set({ folder: path, message: ipcErrorMessage(error) });
    }
  }

  protected cancel(): void {
    this.store.cancel();
  }

  protected apply(): void {
    if (!this.locked()) {
      void this.store.apply();
    }
  }
}
