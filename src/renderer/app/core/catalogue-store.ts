import { inject, Injectable, resource, signal } from '@angular/core';
import { createLogger } from '@shared/log';
import { DESKTOP, ipcErrorMessage } from './desktop';
import { WorkerClient } from './worker-client';

const log = createLogger('catalogue');

/** The classification catalogue chosen in Settings, shared by every page that offers it. */
@Injectable({ providedIn: 'root' })
export class CatalogueStore {
  private readonly worker = inject(WorkerClient);
  private readonly desktop = inject(DESKTOP);
  private readonly revision = signal(0);

  /** The catalogue chosen, as the indexer last read it; `null` when none is. */
  readonly status = resource({
    params: () => ({ connection: this.worker.generation(), revision: this.revision() }),
    loader: () => this.worker.call('getCatalogue'),
  });
  /** The file dialog is open, or the file chosen is being read. */
  readonly choosing = signal(false);
  /** Why the file chosen last cannot be used; it goes with the next attempt. */
  readonly error = signal<string | null>(null);

  constructor() {
    // Lives as long as the app: the subscription stays.
    this.worker.on('catalogueChanged', () => {
      this.revision.update((value) => value + 1);
    });
  }

  /** Asks for a catalogue and uses it from then on; nothing changes when the dialog is canceled. */
  async choose(): Promise<void> {
    if (this.choosing()) {
      return;
    }
    this.error.set(null);
    this.choosing.set(true);
    try {
      await this.desktop.chooseCatalogue();
    } catch (error) {
      log.warn('Cannot use the catalogue:', error);
      this.error.set(ipcErrorMessage(error));
    } finally {
      this.choosing.set(false);
    }
  }

  async forget(): Promise<void> {
    this.error.set(null);
    try {
      await this.worker.call('forgetCatalogue');
    } catch (error) {
      log.warn('Cannot forget the catalogue:', error);
      this.error.set(ipcErrorMessage(error));
    }
  }
}
