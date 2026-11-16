import { DatePipe, DecimalPipe, formatNumber } from '@angular/common';
import {
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  LOCALE_ID,
  viewChild,
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import type {
  CatalogueFilters,
  CatalogueImportDetails,
  TagImportMissReason,
  TagImportPreview as Preview,
  TagImportSkip,
  TagImportSource,
  TagStudioLeftOut,
} from '@shared/model';
import { MAX_TAG_ALIASES, MAX_TAG_PARENTS } from '@shared/tag-names';
import { ipcErrorMessage } from '../../core/desktop';
import { Icon } from '../../ui/icon/icon';
import { importAdditions } from './tag-import-words';
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
  ambiguous: 'several files have this name',
  notMedia: 'not an image or a video',
  notFound: 'not found',
};

/** For a TagStudio library, whose one folder is on this computer. */
const TAGSTUDIO_REASON_LABELS: Readonly<Record<TagImportMissReason, string>> = {
  ...REASON_LABELS,
  folder: 'outside your library folders',
};

/** `1 tag`, `3,410 tags`: the number as the `number` pipe writes it. */
function counted(count: number, one: string, many: string, locale: string): string {
  return `${formatNumber(count, locale)} ${count === 1 ? one : many}`;
}

/** What a TagStudio library holds that does not come over, a line for each kind of thing. */
function leftOutLines(leftOut: TagStudioLeftOut, locale: string): string[] {
  const tags = (count: number): string => counted(count, 'tag', 'tags', locale);
  const lines: string[] = [];
  if (leftOut.colors > 0) {
    lines.push(`The colours of ${tags(leftOut.colors)}`);
  }
  if (leftOut.icons > 0) {
    lines.push(`The icons of ${tags(leftOut.icons)}`);
  }
  if (leftOut.categories > 0) {
    lines.push(`The category setting of ${tags(leftOut.categories)}: they come over as tags`);
  }
  if (leftOut.hidden > 0) {
    lines.push(`The hidden setting of ${tags(leftOut.hidden)}: they come over as ordinary tags`);
  }
  if (leftOut.fields > 0) {
    lines.push(
      `${counted(leftOut.fields, 'field', 'fields', locale)} of files (titles, notes, dates…)`,
    );
  }
  if (leftOut.builtIn > 0) {
    lines.push(
      `${counted(leftOut.builtIn, 'built-in tag', 'built-in tags', locale)} of TagStudio not in use, or Meta Tags`,
    );
  }
  if (leftOut.otherFolders > 0) {
    lines.push(
      `${counted(leftOut.otherFolders, 'tagged file', 'tagged files', locale)} in other folders than the library’s own`,
    );
  }
  if (leftOut.broken > 0) {
    lines.push(
      `${counted(leftOut.broken, 'entry', 'entries', locale)} of the library pointing at a tag or a file that is not there`,
    );
  }
  return lines;
}

/** A kind of rows of a classification catalogue that its import may leave out, as a checkbox. */
interface FilterChoice {
  readonly key: keyof CatalogueFilters;
  readonly label: string;
}

/** The kinds of rows a catalogue has, each as its checkbox says it. */
function filterChoicesOf(details: CatalogueImportDetails, locale: string): FilterChoice[] {
  const rows = (count: number): string => counted(count, 'row', 'rows', locale);
  const { matching } = details;
  const choices: FilterChoice[] = [];
  if (matching.lowConfidence > 0) {
    choices.push({
      key: 'lowConfidence',
      label: `Include the ${rows(matching.lowConfidence)} of low confidence`,
    });
  }
  if (matching.flagged > 0) {
    choices.push({
      key: 'flagged',
      label: `Include the ${rows(matching.flagged)} flagged for further review`,
    });
  }
  if (matching.unclear > 0) {
    choices.push({
      key: 'unclear',
      label:
        `Include the ${rows(matching.unclear)} whose subject is unclear ` +
        '(Needs context or audio review)',
    });
  }
  return choices;
}

/** An alias or a parent tag that importing leaves out, and why, in words. */
interface SkipLine {
  readonly what: string;
  readonly why: string;
}

/** Why a library folder could not be added. */
interface AddError {
  readonly folder: string;
  readonly message: string;
}

let nextId = 0;

/** `skip` in words; `locale` writes the limits as the `number` pipe would. */
function skipLine(skip: TagImportSkip, locale: string): SkipLine {
  switch (skip.kind) {
    case 'aliasTaken':
      return {
        what: `${skip.alias} as an alias of ${skip.tag}`,
        why: `already a name of ${skip.owner}`,
      };
    case 'aliasLimit':
      return {
        what: `${skip.alias} as an alias of ${skip.tag}`,
        why: `${skip.tag} would have more than ${formatNumber(MAX_TAG_ALIASES, locale)} aliases`,
      };
    case 'loop':
      return { what: `${skip.parent} as a parent tag of ${skip.tag}`, why: 'would make a loop' };
    case 'parentLimit':
      return {
        what: `${skip.parent} as a parent tag of ${skip.tag}`,
        why: `${skip.tag} would have more than ${formatNumber(MAX_TAG_PARENTS, locale)} parent tags`,
      };
  }
}

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
  private readonly locale = inject(LOCALE_ID);

  readonly source = input.required<TagImportSource>();
  readonly preview = input.required<Preview>();
  /** Paths of the library folders that are offline, as far as known. */
  readonly offlineFolders = input<ReadonlySet<string>>(new Set());

  private readonly primaryButton = viewChild<ElementRef<HTMLButtonElement>>('primary');

  protected readonly headingId = `tag-import-heading-${nextId}`;
  /** Ties the button that imports or closes to what importing would add. */
  protected readonly summaryId = `tag-import-summary-${nextId++}`;
  /** What is said of a TagStudio library: `null` for a tags export. */
  protected readonly tagStudio = computed(() => this.source().tagStudio);
  /** What is said of a classification catalogue: `null` for anything else. */
  protected readonly catalogue = computed(() => this.source().catalogue);
  /** The rows of the catalogue that the import may leave out, each as a checkbox. */
  protected readonly filterChoices = computed(() => {
    const details = this.catalogue();
    return details === null ? [] : filterChoicesOf(details, this.locale);
  });
  /** The files of a catalogue are on this computer, as those of a TagStudio library are. */
  protected readonly reasonLabels = computed(() =>
    this.source().kind === 'tags' ? REASON_LABELS : TAGSTUDIO_REASON_LABELS,
  );
  protected readonly foldersHeading = computed(() => {
    switch (this.source().kind) {
      case 'tagStudio':
        return 'Folder of the TagStudio library';
      case 'catalogue':
        return 'Folder of the catalogue';
      case 'tags':
        return 'Library folders in the tags export';
    }
  });
  /** What a TagStudio library holds that does not come over, in words. */
  protected readonly leftOut = computed(() => {
    const details = this.tagStudio();
    return details === null ? [] : leftOutLines(details.leftOut, this.locale);
  });
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
    const { missing, uncompared, folder, ambiguous, notMedia, notFound } = this.preview().notFound;
    return missing + uncompared + folder + ambiguous + notMedia + notFound;
  });
  protected readonly nothingFound = computed(
    () => this.found() === 0 && this.preview().changed === 0,
  );
  protected readonly additions = computed(() =>
    this.includeChanged() ? this.preview().additionsWithChanged : this.preview().additions,
  );
  /** Files found get tags they do not have yet. */
  protected readonly tagsFiles = computed(
    () => !this.nothingFound() && this.additions().assignments > 0,
  );
  /** The tags the tags export describes add tags, aliases or parent tags, whatever the files. */
  protected readonly definesTags = computed(() => {
    const { created, aliases, links } = this.preview().definitions;
    return created + aliases + links > 0;
  });
  /** Neither files nor tags get anything: Close is the only way on. */
  protected readonly canImport = computed(() => this.tagsFiles() || this.definesTags());
  /** Something to say of the tags the tags export describes: added, known, or left out. */
  protected readonly showDefinitions = computed(() => {
    const { created, aliases, links, knownAs, skipped } = this.preview().definitions;
    return created + aliases + links + knownAs + skipped > 0;
  });
  /** What importing adds, as the summary says it after `Importing`. */
  protected readonly adds = computed(() => {
    const { definitions } = this.preview();
    const toFiles = this.tagsFiles() ? this.additions() : { assignments: 0, files: 0, newTags: 0 };
    return importAdditions(
      {
        assignments: toFiles.assignments,
        files: toFiles.files,
        // The tags described are made whether or not a file gets them; the others with a file.
        newTags: definitions.created + toFiles.newTags,
        aliases: definitions.aliases,
        links: definitions.links,
      },
      'present',
      this.locale,
    );
  });
  /** The first aliases and parent tags importing leaves out, each with why. */
  protected readonly skipped = computed(() =>
    this.preview().definitions.skippedItems.map((skip) => skipLine(skip, this.locale)),
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

  /** Includes the rows of `key`, or leaves them out: the catalogue is previewed again. */
  protected setFilter(key: keyof CatalogueFilters, included: boolean): void {
    const details = this.catalogue();
    if (details !== null && !this.locked()) {
      void this.store.filterCatalogue({ ...details.filters, [key]: included });
    }
  }

  /** `1 file`, `3,410 files`. */
  protected fileCount(count: number): string {
    return counted(count, 'file', 'files', this.locale);
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
