import { DatePipe } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  inject,
  linkedSignal,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { createLogger } from '@shared/log';
import type { FileDetails, TagRef, TagUsage } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { LibraryStore } from '../../core/library-store';
import { WorkerClient } from '../../core/worker-client';
import { DurationPipe } from '../../ui/format/duration-pipe';
import { FileSizePipe } from '../../ui/format/file-size-pipe';
import { Icon } from '../../ui/icon/icon';
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

/** Sidebar: metadata of the selected file, and tag editing for one or many files. */
@Component({
  selector: 'app-details-panel',
  imports: [Icon, TagInput, VideoPreview, DatePipe, FileSizePipe, DurationPipe],
  templateUrl: './details-panel.html',
  styleUrl: './details-panel.css',
})
export class DetailsPanel {
  private readonly store = inject(LibraryStore);
  private readonly worker = inject(WorkerClient);
  private readonly platform = inject(DESKTOP).platform;

  private readonly tagInput = viewChild(TagInput);
  /** Bumped when tags or files change, to reload what is displayed. */
  private readonly revision = signal(0);

  protected readonly revealLabel = REVEAL_LABELS[this.platform] ?? 'Show in Folder';
  protected readonly trashName = TRASH_NAMES[this.platform] ?? 'Trash';
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

  /** Tags on the selection, with how many of the selected files carry each. */
  protected readonly tags = computed<readonly TagUsage[]>(() => {
    if (this.count() === 1) {
      return (this.file()?.tags ?? []).map((tag) => ({ ...tag, fileCount: 1 }));
    }
    return this.selectionTags.value() ?? [];
  });
  /** Tags every selected file already has: no point suggesting them. */
  protected readonly completeTags = computed(
    () =>
      new Set(
        this.tags()
          .filter((tag) => tag.fileCount === this.count())
          .map((tag) => tag.path),
      ),
  );
  /** The file or copy waiting for confirmation before going to the Trash. */
  protected readonly confirmingTrash = linkedSignal<number | undefined, number | null>({
    source: this.singleId,
    computation: () => null,
  });
  protected readonly trashTarget = computed(() => {
    const id = this.confirmingTrash();
    const file = this.file();
    if (id === null || !file) {
      return null;
    }
    return id === file.id ? file : (file.copies.find((copy) => copy.id === id) ?? null);
  });
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
    return file ? file.copies.some((copy) => key(copy.tags) !== key(file.tags)) : false;
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
        if (ids === null || (id !== undefined && ids.includes(id))) {
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

  protected addTag(path: string): void {
    this.worker.call('addTags', this.selectedIds(), [path]).catch((error: unknown) => {
      log.error('Cannot add tag:', error);
    });
  }

  protected removeTag(tag: TagRef): void {
    this.worker.call('removeTags', this.selectedIds(), [tag.id]).catch((error: unknown) => {
      log.error('Cannot remove tag:', error);
    });
  }

  /** Clicking a tag searches for it. */
  protected searchTag(tag: TagRef): void {
    this.store.query.set(/[\s",]/.test(tag.path) ? `tag:"${tag.path}"` : `tag:${tag.path}`);
  }

  protected shareTags(id: number): void {
    this.worker.call('shareTagsWithCopies', id).catch((error: unknown) => {
      log.error('Cannot share tags with copies:', error);
    });
  }

  protected confirmTrash(id: number): void {
    this.trashError.set(null);
    this.confirmingTrash.set(id);
  }

  protected async trash(id: number): Promise<void> {
    this.trashing.set(true);
    try {
      await this.store.trash(id);
      this.confirmingTrash.set(null);
    } catch (error) {
      this.trashError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.trashing.set(false);
    }
  }

  protected tagList(tags: readonly TagRef[]): string {
    return tags.map((tag) => tag.path).join(', ');
  }

  protected open(id: number): void {
    this.store.open(id);
  }

  protected reveal(id: number): void {
    this.store.reveal(id);
  }
}
