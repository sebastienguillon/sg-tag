import { DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { LibraryStore } from '../../core/library-store';
import { Icon } from '../../ui/icon/icon';

@Component({
  selector: 'app-status-bar',
  imports: [Icon, DecimalPipe],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
  host: { role: 'status' },
})
export class StatusBar {
  private readonly store = inject(LibraryStore);

  protected readonly status = this.store.status;
  protected readonly shown = computed(() => this.store.ids().length);
  protected readonly filtered = computed(() => this.store.query().trim() !== '');
  protected readonly elapsedMs = this.store.elapsedMs;
  protected readonly selected = computed(() => this.store.selection().size);
}
