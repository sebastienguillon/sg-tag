import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DesktopBridge } from '@shared/desktop-api';
import type {
  IndexStatus,
  TagExportResult,
  TagImportPreview,
  TagImportResult,
  TagImportSource,
  TagTransferProgress,
} from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { WorkerClient } from '../../core/worker-client';
import { TagTransfer } from '../../settings/tag-transfer/tag-transfer';
import { FakeWorkerClient, fakeDesktop, settle } from '../../testing/fake-worker-client';
import { StatusBar } from './status-bar';

const exported: TagExportResult = {
  path: '/Users/seb/Documents/SG Tag tags 2026-10-19.jsonl',
  files: 1_234,
  missing: 0,
  tags: 12,
  leftOut: 0,
};

const source: TagImportSource = {
  token: 'token-1',
  name: 'SG Tag tags 2026-10-12.jsonl',
  exportedAt: '2026-10-12T12:00:00.000Z',
  platform: 'darwin',
  files: 3,
  tags: 2,
  invalid: 0,
  problems: [],
};

const preview: TagImportPreview = {
  planId: 1,
  found: { samePlace: 3, moved: 0, shared: 0 },
  changed: 0,
  notFound: { missing: 0, uncompared: 0, folder: 0, notFound: 0 },
  folders: [
    {
      exported: '/Users/seb/Pictures',
      files: 3,
      found: 3,
      foundIn: ['/Users/seb/Pictures'],
      inLibrary: true,
      suspicious: false,
      addable: false,
    },
  ],
  movedItems: [],
  changedItems: [],
  missedItems: [],
  additions: { assignments: 4, files: 3, newTags: 0 },
  additionsWithChanged: { assignments: 4, files: 3, newTags: 0 },
};

const status = (tagTransfer: TagTransferProgress | null): IndexStatus => ({
  totalFiles: 3,
  scanning: null,
  pendingThumbnails: 0,
  offlineRoots: 0,
  duplicateCheck: null,
  tagTransfer,
  removingFolders: 0,
});

const readOnly = new Error(
  "Error invoking remote method 'tags:export': Error: The tags export could not be saved: that disk is read-only.",
);

describe('StatusBar', () => {
  let worker: FakeWorkerClient;
  let exportTags: DesktopBridge['exportTags'];
  let bar: ComponentFixture<StatusBar> | null;
  let settings: ComponentFixture<TagTransfer> | null;

  const render = async (): Promise<void> => {
    await settle();
    await bar?.whenStable();
    await settings?.whenStable();
  };
  const text = (element: Element | null | undefined): string =>
    element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const host = (fixture: ComponentFixture<unknown> | null): HTMLElement | null =>
    (fixture?.nativeElement as HTMLElement | undefined) ?? null;
  const button = (label: string): HTMLButtonElement | undefined =>
    [...(host(settings)?.querySelectorAll('button') ?? [])].find(
      (candidate) => text(candidate) === label,
    );
  /** The library, with its status bar, is shown instead of Settings. */
  const showLibrary = async (): Promise<void> => {
    settings?.destroy();
    settings = null;
    bar = TestBed.createComponent(StatusBar);
    await render();
  };
  /** Settings, with its Tags section, is shown instead of the library. */
  const showSettings = async (): Promise<void> => {
    bar?.destroy();
    bar = null;
    settings = TestBed.createComponent(TagTransfer);
    settings.componentRef.setInput('dataDir', '/Users/seb/Library/Application Support/SG Tag');
    settings.componentRef.setInput('taggedFiles', 1_234);
    await render();
  };
  const notice = (): HTMLAnchorElement | null =>
    host(bar)?.querySelector<HTMLAnchorElement>('a') ?? null;

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    worker.respond('getStatus', () => status(null));
    worker.respond('listTags', () => []);
    worker.respond('getLastTagExport', () => null);
    worker.respond('closeTagImport', () => undefined);
    exportTags = () => Promise.resolve(exported);
    bar = null;
    settings = null;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: WorkerClient, useValue: worker },
        {
          provide: DESKTOP,
          useValue: {
            ...fakeDesktop,
            exportTags: () => exportTags(),
            openTagImport: () => Promise.resolve(source),
          },
        },
      ],
    });
    await showSettings();
  });

  it('points to Settings when an export fails while Settings is not shown', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…')?.click();
    await render();
    await showLibrary();
    worker.emit('status', status({ step: 'exporting', done: 400, total: 1_234 }));
    await render();
    expect(text(host(bar))).toContain('Exporting tags · 400 of 1,234 files');
    expect(notice()).toBeNull();

    saving.reject(readOnly);
    worker.emit('status', status(null));
    await render();
    expect(text(host(bar))).not.toContain('Exporting tags');
    expect(text(notice())).toBe('Tags export failed · see Settings');
    expect(notice()?.getAttribute('href')).toBe('/settings');
    notice()?.focus();
    expect(document.activeElement).toBe(notice());

    // Settings says why: the status bar has nothing more to point to.
    await showSettings();
    expect(text(host(settings)?.querySelector('[role="alert"]'))).toBe(
      'The tags export could not be saved: that disk is read-only.',
    );
    await showLibrary();
    expect(notice()).toBeNull();
  });

  it('points to nothing when Settings showed why the export failed, or it was saved', async () => {
    exportTags = () => Promise.reject(readOnly);
    button('Export tags…')?.click();
    await render();
    expect(host(settings)?.querySelector('[role="alert"]')).not.toBeNull();
    await showLibrary();
    expect(notice()).toBeNull();

    await showSettings();
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…')?.click();
    await render();
    await showLibrary();
    saving.resolve(exported);
    await render();
    expect(notice()).toBeNull();
  });

  it('points to Settings when an import stops partway while Settings is not shown', async () => {
    const applying = Promise.withResolvers<TagImportResult>();
    worker.respond('planTagImport', () => preview);
    worker.respond('applyTagImport', () => applying.promise);
    button('Import tags…')?.click();
    await render();
    button('Import tags')?.click();
    await render();
    await showLibrary();
    expect(notice()).toBeNull();

    applying.reject(new Error('database or disk is full'));
    await render();
    expect(text(notice())).toBe('Tags import failed · see Settings');

    await showSettings();
    expect(text(host(settings)?.querySelector('[role="alert"]'))).toContain(
      'The tags added before the import stopped are kept',
    );
    await showLibrary();
    expect(notice()).toBeNull();
  });

  it('points to Settings when an import leaves files out while Settings is not shown', async () => {
    const applying = Promise.withResolvers<TagImportResult>();
    worker.respond('planTagImport', () => preview);
    worker.respond('applyTagImport', () => applying.promise);
    button('Import tags…')?.click();
    await render();
    button('Import tags')?.click();
    await render();
    await showLibrary();
    worker.emit('status', status({ step: 'importing', done: 1, total: 3 }));
    await render();
    expect(text(host(bar))).toContain('Importing tags · 1 of 3 files');

    // Two of the files went to the Trash during the import, say.
    applying.resolve({ assignments: 1, files: 1, newTags: 0, skipped: 2, notFound: 0 });
    worker.emit('status', status(null));
    await render();
    expect(text(host(bar))).not.toContain('Importing tags');
    expect(text(notice())).toBe('Tags import left files out · see Settings');
    expect(notice()?.getAttribute('href')).toBe('/settings');

    await showSettings();
    expect(text(host(settings)?.querySelector('[role="status"]'))).toContain(
      '2 files changed or left the library during the import and were left out',
    );
    await showLibrary();
    expect(notice()).toBeNull();
  });

  it('points to nothing when an import adds every tag, or Settings shows the files it left out', async () => {
    let applying = Promise.withResolvers<TagImportResult>();
    worker.respond('planTagImport', () => preview);
    worker.respond('applyTagImport', () => applying.promise);
    button('Import tags…')?.click();
    await render();
    button('Import tags')?.click();
    await render();
    await showLibrary();
    applying.resolve({ assignments: 4, files: 3, newTags: 0, skipped: 0, notFound: 0 });
    await render();
    expect(notice()).toBeNull();

    await showSettings();
    applying = Promise.withResolvers<TagImportResult>();
    button('Import tags…')?.click();
    await render();
    button('Import tags')?.click();
    await render();
    applying.resolve({ assignments: 1, files: 1, newTags: 0, skipped: 2, notFound: 0 });
    await render();
    await showLibrary();
    expect(notice()).toBeNull();
  });

  it('points to Settings when an export leaves tags out while Settings is not shown', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…')?.click();
    await render();
    await showLibrary();

    saving.resolve({ ...exported, leftOut: 3 });
    await render();
    expect(text(notice())).toBe('Tags export left tags out · see Settings');

    await showSettings();
    expect(text(host(settings)?.querySelector('[role="status"]'))).toContain(
      '3 tags could not be exported',
    );
    await showLibrary();
    expect(notice()).toBeNull();
  });

  it('points to Settings when the indexer restarts during an import Settings no longer shows', async () => {
    worker.respond('planTagImport', () => preview);
    worker.respond('applyTagImport', () => new Promise<TagImportResult>(() => undefined));
    button('Import tags…')?.click();
    await render();
    button('Import tags')?.click();
    await render();
    await showLibrary();

    worker.reconnect();
    await render();
    expect(text(notice())).toBe('Tags import failed · see Settings');
  });
});
