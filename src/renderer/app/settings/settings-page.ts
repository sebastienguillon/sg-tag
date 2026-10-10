import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryRoot } from '@shared/model';
import { DESKTOP } from '../core/desktop';
import { WorkerClient } from '../core/worker-client';
import { Icon } from '../ui/icon/icon';

@Component({
  selector: 'app-settings-page',
  imports: [Icon, RouterLink, DecimalPipe],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
})
export class SettingsPage {
  private readonly worker = inject(WorkerClient);
  private readonly desktop = inject(DESKTOP);
  private readonly revision = signal(0);

  protected readonly roots = resource({
    params: () => ({ connection: this.worker.generation(), revision: this.revision() }),
    loader: () => this.worker.call('listRoots'),
  });
  protected readonly diagnostics = resource({
    params: () => ({ connection: this.worker.generation() }),
    loader: () => this.worker.call('getDiagnostics'),
  });
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** Root awaiting confirmation of its removal. */
  protected readonly confirming = signal<number | null>(null);

  constructor() {
    const unsubscribe = this.worker.on('rootsChanged', () => {
      this.revision.update((value) => value + 1);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  protected async addFolder(): Promise<void> {
    this.error.set(null);
    const path = await this.desktop.pickFolder();
    if (path !== null) {
      await this.run(() => this.worker.call('addRoot', path));
    }
  }

  protected async remove(root: LibraryRoot): Promise<void> {
    this.confirming.set(null);
    await this.run(() => this.worker.call('removeRoot', root.id));
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
