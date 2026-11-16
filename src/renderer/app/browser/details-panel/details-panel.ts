import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  Injector,
  linkedSignal,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { createLogger } from '@shared/log';
import type { FileCopy, FileDetails, Tag, TagRef, TagUsage } from '@shared/model';
import { describeTagNameProblem, tagTerm } from '@shared/tag-names';
import { DESKTOP, ipcErrorMessage } from '../../core/desktop';
import { LibraryStore } from '../../core/library-store';
import { TagsStore } from '../../core/tags-store';
import { WorkerClient } from '../../core/worker-client';
import { DurationPipe } from '../../ui/format/duration-pipe';
import { FileSizePipe } from '../../ui/format/file-size-pipe';
import { quote } from '../../ui/format/quote';
import { Icon } from '../../ui/icon/icon';
import { Classification } from '../classification/classification';
import { TagEditor } from '../tag-editor/tag-editor';
import { TagInput } from '../tag-input/tag-input';
import { VideoPreview } from '../video-preview/video-preview';

const log = createLogger('details');

const REVEAL_LABELS: Readonly<Record<string, string>> = {
  darwin: 'Show in Finder',
  win32: 'Show in Explorer',
};

const TRASH_NAMES: Readonly<Record<string, string>> = {
  win32: 'Recycle Bin',
};

let nextId = 0;

/** A piece of the "Also found under" line: words, or a tag to search. */
interface FoundUnderPart {
  readonly text: string;
  readonly tag: Tag | null;
}

/**
 * How many of `group` stay on a connected drive if `id` goes to the Trash: only those receive its
 * tags, and the worker keeps a file that would leave none.
 */
function countStaying(group: readonly FileCopy[], id: number): number {
  return group.filter((member) => member.id !== id && !member.offline).length;
}

/** Sidebar: metadata of the selected file, and tag editing for one or many files. */
@Component({
  selector: 'app-details-panel',
  imports: [
    Icon,
    TagInput,
    TagEditor,
    Classification,
    VideoPreview,
    DatePipe,
    FileSizePipe,
    DurationPipe,
  ],
  templateUrl: './details-panel.html',
  styleUrl: './details-panel.css',
  // Takes the focus when the control holding it goes away, such as a file moved to the Trash.
  host: { tabindex: '-1' },
})
export class DetailsPanel {
  private readonly store = inject(LibraryStore);
  private readonly worker = inject(WorkerClient);
  private readonly tagsStore = inject(TagsStore);
  private readonly platform = inject(DESKTOP).platform;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  private readonly tagInput = viewChild(TagInput);
  private readonly editor = viewChild(TagEditor);
  private readonly cancelTrashButton = viewChild<ElementRef<HTMLButtonElement>>('cancel');
  /** The button that asked to move a file to the Trash: Cancel gives it the focus back. */
  private trashOpener: HTMLElement | null = null;
  /** The edit button that opened the tag editor, or `null` for the tag input. */
  private editorOpener: HTMLElement | null = null;
  /** Bumped when tags or files change, to reload what is displayed. */
  private readonly revision = signal(0);

  protected readonly revealLabel = REVEAL_LABELS[this.platform] ?? 'Show in Folder';
  protected readonly trashName = TRASH_NAMES[this.platform] ?? 'Trash';
  /** Ties the trash confirmation to its question. */
  protected readonly trashQuestionId = `trash-question-${nextId++}`;
  protected readonly selectedIds = computed(() => [...this.store.selection()]);
  protected readonly count = computed(() => this.selectedIds().length);
  private readonly singleId = computed(() =>
    this.count() === 1 ? this.selectedIds()[0] : undefined,
  );

  private readonly details = resource({
    params: () => {
      const id = this.singleId();
      return id === undefined ? undefined : { id, revision: this.revision() };
    },
    loader: ({ params }) => this.worker.call('getDetails', params.id),
  });
  /**
   * The details on display. While they reload after a change (a tag added, the file modified), the
   * previous ones stay up: the panel does not blink, and a playing video keeps playing.
   */
  protected readonly file = linkedSignal<
    { id: number | undefined; details: FileDetails | null | undefined },
    FileDetails | null | undefined
  >({
    source: () => ({
      id: this.singleId(),
      details: this.details.hasValue() ? this.details.value() : undefined,
    }),
    computation: ({ id, details }, previous) => {
      const shown = previous?.value;
      return details === undefined && shown?.id === id ? shown : details;
    },
  });

  private readonly selectionTags = resource({
    params: () =>
      this.count() > 1 ? { ids: this.selectedIds(), revision: this.revision() } : undefined,
    loader: ({ params }) => this.worker.call('getSelectionTags', params.ids),
  });

  /**
   * The tags of several files on display. While they reload after a change, the previous ones stay
   * up, as `file` does for one file: each chip stays where it is, and keeps the focus it has.
   */
  private readonly shownSelectionTags = linkedSignal<
    { selection: ReadonlySet<number>; tags: readonly TagUsage[] | undefined },
    readonly TagUsage[] | undefined
  >({
    source: () => ({
      selection: this.store.selection(),
      tags: this.selectionTags.hasValue() ? this.selectionTags.value() : undefined,
    }),
    computation: ({ selection, tags }, previous) =>
      tags === undefined && previous?.source.selection === selection ? previous.value : tags,
  });

  /** Tags on the selection, with how many of the selected files carry each. */
  protected readonly tags = computed<readonly TagUsage[]>(() => {
    if (this.count() === 1) {
      return (this.file()?.tags ?? []).map((tag) => ({ ...tag, fileCount: 1 }));
    }
    return this.shownSelectionTags() ?? [];
  });
  /**
   * The tags above those of the selection, at any depth, that are not among them: a search for one
   * of them finds the selected files too. Each is listed once, after the tag of the selection it is
   * reached from, the first in name order when several are.
   */
  protected readonly foundUnder = computed<readonly FoundUnderPart[]>(() => {
    const tags = this.tags();
    const own = new Set(tags.map((tag) => tag.id));
    const listed = new Set<number>();
    const parts: FoundUnderPart[] = [];
    for (const tag of this.tagsStore.inNameOrder(tags)) {
      const above = this.tagsStore
        .above(tag.id)
        .filter((other) => !own.has(other.id) && !listed.has(other.id));
      if (above.length === 0) {
        continue;
      }
      parts.push({ text: parts.length === 0 ? 'Also found under: ' : ' · ', tag: null });
      above.forEach((other, index) => {
        listed.add(other.id);
        if (index > 0) {
          parts.push({ text: ', ', tag: null });
        }
        parts.push({ text: other.name, tag: other });
      });
      parts.push({ text: ` (through ${tag.name})`, tag: null });
    }
    return parts;
  });
  /**
   * The tag being edited, below the chips; `null` when none is. One at a time, and none once other
   * files are selected.
   */
  protected readonly editing = linkedSignal<ReadonlySet<number>, number | null>({
    source: this.store.selection,
    computation: () => null,
  });
  /** Tags every selected file already has: the tag input offers to edit them, not to add them. */
  protected readonly completeTags = computed(
    () =>
      new Set(
        this.tags()
          .filter((tag) => tag.fileCount === this.count())
          .map((tag) => tag.id),
      ),
  );
  /**
   * Why the worker made no tag of a name sent from the tag input: the line names a text that was
   * not added, which the field no longer holds. It goes when another name is sent or other files
   * are selected, and the refusal of a later name takes its place. A refusal that arrives after a
   * later name was sent shows all the same, and stays: its text was not added either.
   */
  protected readonly tagRefusal = linkedSignal<ReadonlySet<number>, string | null>({
    source: this.store.selection,
    computation: () => null,
  });
  /**
   * Why a change to the tags of the selection failed, when the worker could not make it at all: a
   * tag added or removed, or the tags given to identical copies. It goes with the next attempt, or
   * when other files are selected.
   */
  protected readonly changeError = linkedSignal<ReadonlySet<number>, string | null>({
    source: this.store.selection,
    computation: () => null,
  });
  /**
   * The file and copies moved to the Trash from here. The index may only catch up later, after a
   * scan for instance: until a reload stops returning them, they are neither listed nor counted.
   */
  private readonly trashed = linkedSignal<
    { id: number | undefined; file: FileDetails | null | undefined },
    ReadonlySet<number>
  >({
    source: () => ({ id: this.singleId(), file: this.file() }),
    computation: ({ id, file }, previous) => {
      if (previous === undefined || previous.source.id !== id) {
        return new Set();
      }
      const returned = file ? [file.id, ...file.copies.map((copy) => copy.id)] : [];
      return new Set([...previous.value].filter((trashedId) => returned.includes(trashedId)));
    },
  });
  /** The selected file went to the Trash from here: nothing more can be done with it. */
  protected readonly fileTrashed = computed(() => {
    const file = this.file();
    return file ? this.trashed().has(file.id) : false;
  });
  /** The identical copies still on disk. */
  protected readonly copies = computed(() => {
    const trashed = this.trashed();
    return (this.file()?.copies ?? []).filter((copy) => !trashed.has(copy.id));
  });
  /** The file and its identical copies still on disk. */
  private readonly group = computed<readonly FileCopy[]>(() => {
    const file = this.file();
    return file && !this.fileTrashed() ? [file, ...this.copies()] : this.copies();
  });
  /**
   * The file or copy waiting for confirmation before going to the Trash. The confirmation goes as
   * soon as the file cannot: it does not come back by itself when, say, a drive is connected again.
   */
  protected readonly confirmingTrash = linkedSignal<
    { id: number | undefined; group: readonly FileCopy[] },
    number | null
  >({
    source: () => ({ id: this.singleId(), group: this.group() }),
    computation: ({ id, group }, previous) => {
      const confirming =
        previous !== undefined && previous.source.id === id ? previous.value : null;
      const target = group.find((member) => member.id === confirming);
      return target && !target.offline && countStaying(group, target.id) > 0 ? target.id : null;
    },
  });
  /** The file or copy to confirm. */
  protected readonly trashTarget = computed(
    () => this.group().find((member) => member.id === this.confirmingTrash()) ?? null,
  );
  /** Who gets the tags of the file going to the Trash: the copies left on a connected drive. */
  protected readonly trashHeirs = computed(() => {
    const target = this.trashTarget();
    const staying = target ? this.staying(target.id) : 0;
    if (staying === this.group().length - 1) {
      return staying === 1 ? 'the copy that stays' : 'the copies that stay';
    }
    return staying === 1
      ? 'the copy on a connected drive'
      : `the ${staying} copies on connected drives`;
  });
  /** Title of a trash button disabled because no other copy is on a connected drive. */
  protected readonly othersOfflineTitle = computed(() =>
    this.group().length === 2
      ? 'The other copy is on a drive that is not connected'
      : 'The other copies are on drives that are not connected',
  );
  protected readonly trashing = signal(false);
  protected readonly trashError = linkedSignal<number | undefined, string | null>({
    source: this.singleId,
    computation: () => null,
  });
  /** The file and its copies do not all carry the same tags. */
  protected readonly copiesDiffer = computed(() => {
    const file = this.file();
    const key = (tags: readonly TagRef[]): string =>
      tags
        .map((tag) => tag.id)
        .sort((a, b) => a - b)
        .join(',');
    return file ? this.copies().some((copy) => key(copy.tags) !== key(file.tags)) : false;
  });

  protected readonly thumbnailUrl = computed(() => {
    const file = this.file();
    return file ? `thumb://file/${file.id}?v=${file.mtimeMs}` : null;
  });

  constructor() {
    const bump = (): void => {
      this.revision.update((value) => value + 1);
    };
    const subscriptions = [
      this.worker.on('tagsChanged', bump),
      this.worker.on('filesChanged', ({ ids }) => {
        const id = this.singleId();
        // The copies too: one moved to the Trash, changed or deleted must not linger in the list.
        const copies = this.file()?.copies ?? [];
        if (
          ids === null ||
          (id !== undefined && ids.includes(id)) ||
          copies.some((copy) => ids.includes(copy.id))
        ) {
          bump();
        }
      }),
      this.worker.on('mediaChanged', ({ ids }) => {
        const id = this.singleId();
        if (id !== undefined && ids.includes(id)) {
          bump();
        }
      }),
    ];
    inject(DestroyRef).onDestroy(() => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
    });
  }

  focusTagInput(): void {
    this.tagInput()?.focus();
  }

  protected async addTag(name: string): Promise<void> {
    // If other files get selected meanwhile, a refusal must not show up in front of them.
    const selection = this.store.selection();
    this.tagRefusal.set(null);
    this.changeError.set(null);
    try {
      const outcomes = await this.worker.call('addTags', this.selectedIds(), [name]);
      const refused = outcomes.find((outcome) => outcome.status === 'refused');
      if (refused && this.store.selection() === selection) {
        this.tagRefusal.set(
          `“${quote(name)}” was not added. ${describeTagNameProblem(refused.problem)}`,
        );
      }
    } catch (error) {
      log.error('Cannot add tag:', error);
      this.reportChangeError(selection, error);
    }
  }

  protected removeTag(tag: TagRef): void {
    const selection = this.store.selection();
    this.changeError.set(null);
    this.worker.call('removeTags', this.selectedIds(), [tag.id]).catch((error: unknown) => {
      log.error('Cannot remove tag:', error);
      this.reportChangeError(selection, error);
    });
  }

  /** Says why a change to the tags of `selection` failed, if those files are still selected. */
  private reportChangeError(selection: ReadonlySet<number>, error: unknown): void {
    if (this.store.selection() === selection) {
      this.changeError.set(`The change could not be made: ${ipcErrorMessage(error)}`);
    }
  }

  /**
   * Opens the tag editor below the chips, from the edit button of a chip (`opener`) or from the
   * tag input (`null`): closing it gives the focus back there.
   */
  protected openEditor(id: number, opener: HTMLElement | null): void {
    this.editorOpener = opener;
    if (this.editing() === id) {
      // Already open: the focus goes to it, as when it opens.
      this.editor()?.focus();
    } else {
      this.editing.set(id);
    }
  }

  /**
   * Escape, Close, or the tag deleted: the editor goes, and the focus goes back where it came from.
   * The edit button of a deleted tag goes with its chip, once the tags are read again: the tag
   * input takes the focus then.
   */
  protected closeEditor(deleted = false): void {
    const opener = deleted ? null : this.editorOpener;
    this.editorOpener = null;
    this.editing.set(null);
    if (opener?.isConnected === true) {
      opener.focus();
    } else if (this.tagInput()) {
      this.focusTagInput();
    } else {
      this.host.nativeElement.focus();
    }
  }

  /** The editor follows a tag it merged into another. */
  protected setEditing(id: number): void {
    this.editing.set(id);
  }

  protected setQuery(query: string): void {
    this.store.query.set(query);
  }

  /** The search that lists the files of a tag, and of the tags below it. */
  protected tagSearch(tag: TagRef): string {
    return tagTerm(tag.name);
  }

  /** Clicking a tag searches for it. */
  protected searchTag(tag: TagRef): void {
    this.store.query.set(this.tagSearch(tag));
  }

  protected shareTags(id: number): void {
    const selection = this.store.selection();
    this.changeError.set(null);
    this.worker.call('shareTagsWithCopies', id).catch((error: unknown) => {
      log.error('Cannot share tags with copies:', error);
      this.reportChangeError(selection, error);
    });
  }

  /** How many of the file and its copies stay on a connected drive if `id` goes to the Trash. */
  protected staying(id: number): number {
    return countStaying(this.group(), id);
  }

  protected confirmTrash(id: number, opener: HTMLElement): void {
    this.trashError.set(null);
    this.confirmingTrash.set(id);
    this.trashOpener = opener;
    // Cancel is the safe default for a destructive action.
    afterNextRender(
      () => {
        this.cancelTrashButton()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** Cancel or Escape: nothing moves, and the focus goes back where it was. */
  protected cancelTrash(): void {
    // Once under way, the move happens anyway: closing would say otherwise.
    if (this.trashing()) {
      return;
    }
    this.confirmingTrash.set(null);
    this.trashOpener?.focus();
  }

  protected onConfirmEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelTrash();
  }

  protected async trash(id: number): Promise<void> {
    // If another file gets selected during the move, its outcome must not disturb that one.
    const selected = this.singleId();
    this.trashing.set(true);
    try {
      await this.store.trash(id);
      const file = this.file();
      // Left out until the index catches up, unless a reload already did or it is unrelated now.
      if (file && (file.id === id || file.copies.some((copy) => copy.id === id))) {
        this.trashed.update((ids) => new Set(ids).add(id));
      }
      if (this.singleId() === selected) {
        this.confirmingTrash.set(null);
        // The confirmation goes, and the moved file's row or the whole section may go with it.
        this.keepFocusIn(this.host.nativeElement);
      }
    } catch (error) {
      if (this.singleId() === selected) {
        this.trashError.set(error instanceof Error ? error.message : String(error));
        // Moving disabled the button that had the focus, and Cancel until the move is over.
        afterNextRender(
          () => {
            this.keepFocusIn(this.cancelTrashButton()?.nativeElement ?? this.host.nativeElement);
          },
          { injector: this.injector },
        );
      }
    } finally {
      this.trashing.set(false);
    }
  }

  /**
   * Gives the focus to `target`, unless the user put it elsewhere in the meantime, such as on a
   * tile or in the search field: the grid shortcuts must keep working there.
   */
  private keepFocusIn(target: HTMLElement): void {
    const active = this.document.activeElement;
    if (
      active === null ||
      active === this.document.body ||
      this.host.nativeElement.contains(active)
    ) {
      target.focus();
    }
  }

  protected tagList(tags: readonly TagRef[]): string {
    return tags.map((tag) => tag.name).join(', ');
  }

  protected open(id: number): void {
    this.store.open(id);
  }

  protected reveal(id: number): void {
    this.store.reveal(id);
  }
}
