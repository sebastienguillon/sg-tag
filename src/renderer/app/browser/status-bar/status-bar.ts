import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library-store';
import { TagTransferStore } from '../../settings/tag-transfer/tag-transfer-store';
import { Icon } from '../../ui/icon/icon';

@Component({
  selector: 'app-status-bar',
  imports: [Icon, DecimalPipe, PercentPipe, RouterLink],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
  host: { role: 'status' },
})
export class StatusBar {
  private readonly store = inject(LibraryStore);
  private readonly transfer = inject(TagTransferStore);

  protected readonly status = this.store.status;
  protected readonly shown = computed(() => this.store.ids().length);
  protected readonly filtered = computed(() => this.store.query().trim() !== '');
  protected readonly elapsedMs = this.store.elapsedMs;
  protected readonly selected = computed(() => this.store.selection().size);
  /**
   * A tags export or import that failed, or left something out, once Settings was left: only
   * Settings says what.
   */
  protected readonly transferNotice = this.transfer.unseenNotice;
}
