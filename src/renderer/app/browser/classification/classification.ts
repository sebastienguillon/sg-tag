import {
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  linkedSignal,
  resource,
  signal,
} from '@angular/core';
import { createLogger } from '@shared/log';
import type { CatalogueEntry } from '@shared/model';
import { ipcErrorMessage } from '../../core/desktop';
import { WorkerClient } from '../../core/worker-client';
import { Icon } from '../../ui/icon/icon';

const log = createLogger('classification');

let nextId = 0;

/**
 * In the details panel, what the classification catalogue says of one file, and the tags it
 * suggests: each added on its own, or all at once. Nothing shows when no catalogue is chosen or it
 * does not list the file.
 */
@Component({
  selector: 'app-classification',
  imports: [Icon],
  templateUrl: './classification.html',
  styleUrl: './classification.css',
})
export class Classification {
  private readonly worker = inject(WorkerClient);

  readonly fileId = input.required<number>();

  /** Bumped when tags, the file or the catalogue change, to read the entry again. */
  private readonly revision = signal(0);
  protected readonly headingId = `classification-${nextId++}`;

  private readonly loaded = resource({
    params: () => ({
      id: this.fileId(),
      revision: this.revision(),
      connection: this.worker.generation(),
    }),
    loader: ({ params }) => this.worker.call('getCatalogueEntry', params.id),
  });
  /**
   * The entry on display. While it reloads after a change (a tag added), the previous one stays
   * up, as the details panel keeps its file: the buttons do not blink, and the focus stays.
   */
  protected readonly entry = linkedSignal<
    { id: number; entry: CatalogueEntry | null | undefined },
    CatalogueEntry | null | undefined
  >({
    source: () => ({
      id: this.fileId(),
      entry: this.loaded.hasValue() ? this.loaded.value() : undefined,
    }),
    computation: ({ id, entry }, previous) =>
      entry === undefined && previous?.source.id === id ? previous.value : entry,
  });
  /** The names of the suggested tags the file lacks. */
  protected readonly missing = computed(() =>
    (this.entry()?.suggestions ?? [])
      .filter((suggestion) => !suggestion.added)
      .map((suggestion) => suggestion.name),
  );
  /** Why tags could not be added; it goes with the next attempt, or with another file. */
  protected readonly error = linkedSignal<number, string | null>({
    source: this.fileId,
    computation: () => null,
  });

  constructor() {
    const bump = (): void => {
      this.revision.update((value) => value + 1);
    };
    const subscriptions = [
      this.worker.on('tagsChanged', bump),
      this.worker.on('catalogueChanged', bump),
      this.worker.on('filesChanged', ({ ids }) => {
        if (ids === null || ids.includes(this.fileId())) {
          bump();
        }
      }),
    ];
    inject(DestroyRef).onDestroy(() => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
    });
  }

  /** What follows "Flagged for further review": the review status, when the catalogue gives one. */
  protected reviewStatusOf(entry: CatalogueEntry): string {
    return entry.reviewStatus === null ? '' : `: ${entry.reviewStatus}`;
  }

  /** Adds the tags `names` to the file; none when they are all added already. */
  protected async add(names: readonly string[]): Promise<void> {
    if (names.length === 0) {
      return;
    }
    const id = this.fileId();
    this.error.set(null);
    try {
      await this.worker.call('addCatalogueTags', id, names);
    } catch (error) {
      log.error('Cannot add the tags of the catalogue:', error);
      if (this.fileId() === id) {
        this.error.set(`The tags could not be added: ${ipcErrorMessage(error)}`);
      }
    }
  }
}
