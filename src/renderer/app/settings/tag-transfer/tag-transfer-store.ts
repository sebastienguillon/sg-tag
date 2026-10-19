import { computed, effect, inject, Injectable, resource, signal, untracked } from '@angular/core';
import { createLogger } from '@shared/log';
import type {
  TagExportResult,
  TagImportPreview,
  TagImportResult,
  TagImportSource,
} from '@shared/model';
import { DESKTOP, ipcErrorMessage } from '../../core/desktop';
import { LibraryStore } from '../../core/library-store';
import { WorkerClient } from '../../core/worker-client';

const log = createLogger('tags');

export type ExportState =
  | { readonly step: 'idle' }
  | { readonly step: 'busy' }
  | { readonly step: 'done'; readonly result: TagExportResult }
  | { readonly step: 'error'; readonly message: string };

export type ImportState =
  | { readonly step: 'idle' }
  /** Dialog open, then reading the chosen file. */
  | { readonly step: 'opening' }
  | { readonly step: 'planning'; readonly source: TagImportSource }
  | {
      readonly step: 'preview';
      readonly source: TagImportSource;
      readonly preview: TagImportPreview;
    }
  | {
      readonly step: 'applying';
      readonly source: TagImportSource;
      readonly preview: TagImportPreview;
    }
  | { readonly step: 'done'; readonly result: TagImportResult }
  /**
   * `source`: still open, so it can be checked again. `stopped`: an import stopped partway, and
   * the tags it added are kept.
   */
  | {
      readonly step: 'error';
      readonly message: string;
      readonly source: TagImportSource | null;
      readonly stopped?: boolean;
    };

const IDLE = { step: 'idle' } as const;

/** Main's answer when the indexer exited during the call, or had not started again yet. */
const INDEXER_GONE: ReadonlySet<string> = new Set([
  'The indexer process exited',
  'The indexer is not running',
]);
const EXPORT_RESTARTED = 'The indexer restarted during the export. Try again.';
const IMPORT_RESTARTED = 'The indexer restarted. Open the tags export again.';

/** The indexer holds no tags export of this token any more: checking again cannot work. */
const NOT_OPEN = 'This tags export is no longer open: choose it again.';
/** Refusals of `applyTagImport` that add nothing. */
const REFUSED: ReadonlySet<string> = new Set([
  'This preview is out of date: check again.',
  'Tags are being exported: import them once that is done.',
  'Tags are being imported: wait until that is done.',
  NOT_OPEN,
]);

/** The indexer may still hold a tags export for this state: it must be closed when left. */
function holdsSource(state: ImportState): boolean {
  switch (state.step) {
    case 'opening':
    case 'planning':
    case 'preview':
      return true;
    case 'error':
      return state.source !== null;
    case 'idle':
    case 'applying':
    case 'done':
      return false;
  }
}

/** The message of a failed call through main, saying so plainly when the indexer went away. */
function failure(error: unknown, restarted: string): string {
  const message = ipcErrorMessage(error);
  return INDEXER_GONE.has(message) ? restarted : message;
}

/** How a tags transfer did not end as asked. */
export type TagTransferNotice =
  | 'export-failed'
  /** The tags export was saved without the tags it cannot hold (`TagExportResult.leftOut`). */
  | 'export-left-out'
  | 'import-failed'
  /** The import finished without the files that changed or left the library meanwhile. */
  | 'import-left-out';

/**
 * Exporting the tags to a file, and importing them from one in two steps: a preview of what the
 * import adds, then the import itself.
 *
 * Outlives the Settings page: an export, or an import being applied, goes on when the page is left
 * and still says how it ended when the page is shown again (`show`); until then, an end that was
 * not as asked is pointed to from the status bar (`unseenNotice`). Leaving only closes a tags
 * export that is being read, checked or previewed (`leave`).
 *
 * Every outcome is written only if the state is still the one its call started from: a newer
 * step, a cancel or a restarted indexer wins over a late answer.
 */
@Injectable({ providedIn: 'root' })
export class TagTransferStore {
  private readonly worker = inject(WorkerClient);
  private readonly desktop = inject(DESKTOP);
  private readonly library = inject(LibraryStore);
  private readonly exporting = signal<ExportState>(IDLE);
  private readonly importing = signal<ImportState>(IDLE);
  private readonly addingFolder = signal<string | null>(null);
  private readonly removals = signal(0);
  private readonly unseen = signal<TagTransferNotice | null>(null);
  /** Tags sections of Settings shown: each says how the export and the import ended. */
  private views = 0;

  readonly exportState = this.exporting.asReadonly();
  readonly importState = this.importing.asReadonly();
  /** Library folder being added from the preview, which is then checked again. */
  readonly adding = this.addingFolder.asReadonly();
  /**
   * An export or an import being applied failed, or left something out, while Settings was not
   * shown: it says what once shown again.
   */
  readonly unseenNotice = this.unseen.asReadonly();
  /**
   * A library folder is being removed, which can wait behind indexing for minutes: the indexer
   * refuses to export the tags until its files are gone. Known from the removals this store
   * started, before the indexer reports them, and from those the indexer reports: also one started
   * before the window was reloaded, or from a window closed since.
   */
  readonly removingFolder = computed(
    () => this.removals() > 0 || (this.library.status()?.removingFolders ?? 0) > 0,
  );
  /** The import includes the changed files: yes in each new preview, until left out. */
  readonly includeChanged = signal(true);
  /** What the indexer is doing for the export or import, as it reports it. */
  readonly progress = computed(() => this.library.status()?.tagTransfer ?? null);
  /** The latest tags export saved from this library. */
  readonly lastExport = resource({
    params: () => ({ connection: this.worker.generation() }),
    loader: () => this.worker.call('getLastTagExport'),
  });
  /**
   * The indexer reports an export this store did not start: one started before the window was
   * reloaded, or from a window closed since.
   */
  readonly exportingElsewhere = computed(
    () => this.progress()?.step === 'exporting' && this.exporting().step === 'idle',
  );
  /** Likewise, an import being applied. */
  readonly importingElsewhere = computed(
    () => this.progress()?.step === 'importing' && this.importing().step === 'idle',
  );
  /** A tags export is under way, here or not: removing a library folder must wait. */
  readonly exportRunning = computed(
    () => this.exporting().step === 'busy' || this.exportingElsewhere(),
  );
  /** A tags export or import is under way, or a library folder is being added: none can start. */
  readonly busy = computed(() => {
    const step = this.importing().step;
    return (
      this.exportRunning() ||
      this.importingElsewhere() ||
      this.addingFolder() !== null ||
      step === 'opening' ||
      step === 'planning' ||
      step === 'applying'
    );
  });
  /** An export can start: nothing above is under way, and no library folder is being removed. */
  readonly canExport = computed(() => !this.busy() && !this.removingFolder());
  /** A tags export is open, or being opened: Cancel or Escape closes it. */
  readonly cancelable = computed(() => holdsSource(this.importing()));

  constructor() {
    let connection = this.worker.generation();
    effect(() => {
      const current = this.worker.generation();
      // Connecting for the first time is not a restart.
      if (connection > 0 && current !== connection) {
        untracked(() => {
          this.restarted();
        });
      }
      connection = current;
    });
    let elsewhere = false;
    effect(() => {
      const now = this.exportingElsewhere();
      // That export ended: it may have been saved.
      if (elsewhere && !now) {
        untracked(() => {
          this.lastExport.reload();
        });
      }
      elsewhere = now;
    });
  }

  async export(): Promise<void> {
    if (!this.canExport()) {
      return;
    }
    const started: ExportState = { step: 'busy' };
    this.exporting.set(started);
    try {
      const result = await this.desktop.exportTags();
      if (this.exporting() === started) {
        this.exporting.set(result ? { step: 'done', result } : IDLE);
        if (result) {
          this.lastExport.reload();
          if (result.leftOut > 0) {
            this.notify('export-left-out');
          }
        }
      }
    } catch (error) {
      if (this.exporting() === started) {
        this.exporting.set({ step: 'error', message: failure(error, EXPORT_RESTARTED) });
        this.notify('export-failed');
      }
    }
  }

  /** Asks for a tags export, then previews importing it. */
  async open(): Promise<void> {
    if (this.busy()) {
      return;
    }
    // Opening another tags export replaces this one in the indexer, but a canceled dialog does not.
    const previous = this.importing();
    const connection = this.worker.generation();
    const started: ImportState = { step: 'opening' };
    this.importing.set(started);
    let source: TagImportSource | null = null;
    try {
      source = await this.desktop.openTagImport();
    } catch (error) {
      if (this.importing() === started) {
        this.importing.set({
          step: 'error',
          message: failure(error, IMPORT_RESTARTED),
          source: null,
        });
      }
    }
    if (this.importing() !== started) {
      // Canceled while the file was read, or failed to read: nobody will preview it.
      if (source !== null || holdsSource(previous)) {
        this.close();
      }
      return;
    }
    if (source === null) {
      // Canceled in the dialog: the indexer still holds the tags export shown before, if any,
      // unless it restarted meanwhile.
      if (!holdsSource(previous)) {
        this.importing.set(IDLE);
      } else if (this.worker.generation() === connection) {
        this.importing.set(previous);
      } else {
        this.importing.set({ step: 'error', message: IMPORT_RESTARTED, source: null });
      }
      return;
    }
    await this.plan(source);
  }

  /** Plans the open tags export again (Check again, after adding a folder). */
  async check(): Promise<void> {
    const state = this.importing();
    if ((state.step === 'preview' || state.step === 'error') && state.source !== null) {
      await this.plan(state.source);
    }
  }

  /** Adds `path` as a library folder, then checks again; rejects when it cannot be added. */
  async addFolder(path: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.addingFolder.set(path);
    try {
      await this.worker.call('addRoot', path);
    } finally {
      this.addingFolder.set(null);
    }
    await this.check();
  }

  /** Removes a library folder; no export starts until it is gone. Rejects when it cannot be. */
  async removeFolder(id: number): Promise<void> {
    this.removals.update((count) => count + 1);
    try {
      await this.worker.call('removeRoot', id);
    } finally {
      this.removals.update((count) => count - 1);
    }
  }

  /** Imports the preview shown, with the changed files if `includeChanged`. */
  async apply(): Promise<void> {
    const state = this.importing();
    if (state.step !== 'preview' || this.busy()) {
      return;
    }
    const { source, preview } = state;
    const connection = this.worker.generation();
    const started: ImportState = { step: 'applying', source, preview };
    this.importing.set(started);
    try {
      const result = await this.worker.call(
        'applyTagImport',
        source.token,
        preview.planId,
        this.includeChanged(),
      );
      if (this.importing() === started) {
        this.importing.set({ step: 'done', result });
        if (result.skipped > 0) {
          this.notify('import-left-out');
        }
      }
    } catch (error) {
      if (this.importing() !== started) {
        return;
      }
      this.notify('import-failed');
      if (this.worker.generation() !== connection) {
        // Its connection was replaced: the indexer restarted.
        this.importing.set({ step: 'error', message: IMPORT_RESTARTED, source: null });
        return;
      }
      // The indexer keeps the tags export open, also when an import stopped partway: checking
      // again tells what is left to add.
      const message = ipcErrorMessage(error);
      this.importing.set({
        step: 'error',
        message,
        source: message === NOT_OPEN ? null : source,
        stopped: !REFUSED.has(message),
      });
    }
  }

  /** Cancel or Escape: any step but applying; the indexer forgets the tags export. */
  cancel(): void {
    const state = this.importing();
    if (state.step === 'applying') {
      return;
    }
    this.importing.set(IDLE);
    if (holdsSource(state)) {
      this.close();
    }
  }

  /**
   * Settings shows the Tags section, which says how the export and the import ended: the status
   * bar has nothing left to point to.
   */
  show(): void {
    this.views++;
    this.unseen.set(null);
    // An export may have been saved meanwhile.
    this.lastExport.reload();
  }

  /**
   * Leaving Settings: a tags export being read, checked or previewed is closed. An export, or an
   * import being applied, goes on, and how it ended is shown when Settings is back.
   */
  leave(): void {
    this.views--;
    if (holdsSource(this.importing())) {
      this.importing.set(IDLE);
      this.close();
    }
  }

  private async plan(source: TagImportSource): Promise<void> {
    const started: ImportState = { step: 'planning', source };
    this.importing.set(started);
    try {
      const preview = await this.worker.call('planTagImport', source.token);
      if (this.importing() === started) {
        this.includeChanged.set(true);
        this.importing.set({ step: 'preview', source, preview });
      }
    } catch (error) {
      if (this.importing() === started) {
        const message = ipcErrorMessage(error);
        this.importing.set({
          step: 'error',
          message,
          source: message === NOT_OPEN ? null : source,
        });
      }
    }
  }

  private close(): void {
    this.worker.call('closeTagImport').catch((error: unknown) => {
      log.warn('Cannot close the tags export:', error);
    });
  }

  /** Nothing else would say so until Settings is shown again: the status bar points there. */
  private notify(notice: TagTransferNotice): void {
    if (this.views === 0) {
      this.unseen.set(notice);
    }
  }

  /**
   * The new indexer knows nothing of the tags export the previous one held. An export, and a tags
   * export being opened, go through main to whichever indexer runs: their own outcome says how
   * they ended.
   */
  private restarted(): void {
    const state = this.importing();
    if (
      state.step === 'planning' ||
      state.step === 'preview' ||
      state.step === 'applying' ||
      (state.step === 'error' && state.source !== null)
    ) {
      this.importing.set({ step: 'error', message: IMPORT_RESTARTED, source: null });
    }
    if (state.step === 'applying') {
      this.notify('import-failed');
    }
  }
}
