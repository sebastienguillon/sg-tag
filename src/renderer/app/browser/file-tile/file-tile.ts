import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { LibraryStore } from '../../core/library-store';
import { DurationPipe } from '../../ui/format/duration-pipe';
import { FileSizePipe } from '../../ui/format/file-size-pipe';
import { Icon } from '../../ui/icon/icon';

/** One grid cell: the thumbnail, a type badge, and details revealed on hover. */
@Component({
  selector: 'app-file-tile',
  imports: [Icon, FileSizePipe, DurationPipe],
  templateUrl: './file-tile.html',
  styleUrl: './file-tile.css',
  host: {
    role: 'option',
    '[id]': 'domId()',
    '[attr.data-index]': 'index()',
    '[attr.aria-selected]': 'selected()',
    '[attr.aria-label]': 'file()?.name ?? null',
    '[class.selected]': 'selected()',
    '[class.focused]': 'focused()',
  },
})
export class FileTile {
  private readonly store = inject(LibraryStore);

  readonly fileId = input.required<number>();
  /** Position in the result list, read by the grid's delegated event handlers. */
  readonly index = input.required<number>();
  readonly selected = input(false);
  readonly focused = input(false);

  protected readonly file = computed(() => this.store.summary(this.fileId()));
  protected readonly domId = computed(() => `file-${this.fileId()}`);
  protected readonly kindIcon = computed(() => (this.file()?.kind === 'video' ? 'film' : 'image'));
  /** The version parameter makes edited files load their new thumbnail. */
  protected readonly thumbnailUrl = computed(() => {
    const file = this.file();
    return file ? `thumb://file/${file.id}?v=${file.mtimeMs}` : null;
  });
  protected readonly loaded = linkedSignal({ source: this.thumbnailUrl, computation: () => false });
  protected readonly failed = linkedSignal({ source: this.thumbnailUrl, computation: () => false });
}
