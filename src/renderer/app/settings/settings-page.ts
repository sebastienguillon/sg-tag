import { DecimalPipe } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  Injector,
  linkedSignal,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryRoot, TagExportResult } from '@shared/model';
import { DESKTOP } from '../core/desktop';
import { WorkerClient } from '../core/worker-client';
import { Icon } from '../ui/icon/icon';
import { TagTransfer } from './tag-transfer/tag-transfer';
import { TagTransferStore } from './tag-transfer/tag-transfer-store';

@Component({
  selector: 'app-settings-page',
  imports: [Icon, RouterLink, DecimalPipe, TagTransfer],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
})
export class SettingsPage {
  private readonly worker = inject(WorkerClient);
  private readonly desktop = inject(DESKTOP);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly transfer = inject(TagTransferStore);
  private readonly revision = signal(0);
  private readonly cancelRemoveButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  protected readonly roots = resource({
    params: () => ({ connection: this.worker.generation(), revision: this.revision() }),
    loader: () => this.worker.call('listRoots'),
  });
  protected readonly diagnostics = resource({
    params: () => ({ connection: this.worker.generation() }),
    loader: () => this.worker.call('getDiagnostics'),
  });
  /** Tagged files in the library; `null` until known. */
  protected readonly taggedFiles = computed(() =>
    this.roots.hasValue()
      ? this.roots.value().reduce((sum, root) => sum + root.taggedCount, 0)
      : null,
  );
  /** Paths of the library folders that are offline. */
  protected readonly offlineFolders = computed(() => {
    const roots = this.roots.hasValue() ? this.roots.value() : [];
    return new Set(roots.filter((root) => !root.online).map((root) => root.path));
  });
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** Root awaiting confirmation of its removal. */
  protected readonly confirming = signal<number | null>(null);
  /**
   * The tags export made from the confirmation: removing the root loses none of its tags but those
   * the export could not hold (`TagExportResult.leftOut`).
   */
  protected readonly exportedBeforeRemoval = linkedSignal({
    source: this.confirming,
    computation: (): TagExportResult | null => null,
  });

  constructor() {
    const unsubscribe = this.worker.on('rootsChanged', () => {
      this.revision.update((value) => value + 1);
    });
    this.destroyRef.onDestroy(unsubscribe);
  }

  protected async addFolder(): Promise<void> {
    this.error.set(null);
    const path = await this.desktop.pickFolder();
    if (path !== null) {
      await this.run(() => this.worker.call('addRoot', path));
    }
  }

  protected confirmRemove(root: LibraryRoot): void {
    this.confirming.set(root.id);
    // Cancel is the safe default for a destructive action.
    this.afterRender(() => {
      this.cancelRemoveButton()?.nativeElement.focus();
    });
  }

  /** Cancel or Escape: nothing is removed, and the focus goes back to the remove button. */
  protected cancelRemove(root: LibraryRoot): void {
    this.confirming.set(null);
    this.afterRender(() => {
      this.document.getElementById(this.removeButtonId(root))?.focus();
    });
  }

  protected onConfirmEscape(event: Event, root: LibraryRoot): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelRemove(root);
  }

  protected async exportBeforeRemoving(root: LibraryRoot): Promise<void> {
    if (!this.transfer.canExport()) {
      return;
    }
    await this.transfer.export();
    const exported = this.transfer.exportState();
    // The export outlives the page: it may have been left meanwhile.
    if (!this.destroyRef.destroyed && exported.step === 'done' && this.confirming() === root.id) {
      this.exportedBeforeRemoval.set(exported.result);
      // Export tags… went away with the warning it answered: Cancel takes the focus it had.
      this.afterRender(() => {
        const active = this.document.activeElement;
        if (active === null || active === this.document.body) {
          this.cancelRemoveButton()?.nativeElement.focus();
        }
      });
    }
  }

  /**
   * Not while tags are being exported: the export would leave out the folder's tags. Through the
   * tags transfer, which starts no export until the folder is gone, also once Settings is left.
   */
  protected async remove(root: LibraryRoot): Promise<void> {
    if (this.transfer.exportRunning()) {
      return;
    }
    this.confirming.set(null);
    await this.run(() => this.transfer.removeFolder(root.id));
  }

  protected removeButtonId(root: LibraryRoot): string {
    return `remove-root-${root.id}`;
  }

  private afterRender(callback: () => void): void {
    afterNextRender(callback, { injector: this.injector });
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
