import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DesktopBridge } from '@shared/desktop-api';
import type {
  IndexStatus,
  LibraryRoot,
  TagExportRecord,
  TagExportResult,
  TagTransferProgress,
} from '@shared/model';
import { DESKTOP } from '../core/desktop';
import { WorkerClient } from '../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../testing/fake-worker-client';
import { SettingsPage } from './settings-page';

const pictures: LibraryRoot = {
  id: 1,
  path: '/Users/seb/Pictures',
  online: true,
  fileCount: 4_334,
  taggedCount: 1_234,
};
const videos: LibraryRoot = {
  id: 2,
  path: '/Users/seb/Movies',
  online: true,
  fileCount: 120,
  taggedCount: 0,
};
const exported: TagExportResult = {
  path: '/Users/seb/Documents/SG Tag tags 2026-10-19.jsonl',
  files: 1_234,
  missing: 0,
  tags: 12,
  leftOut: 0,
};

const status = (tagTransfer: TagTransferProgress | null): IndexStatus => ({
  totalFiles: 0,
  scanning: null,
  pendingThumbnails: 0,
  offlineRoots: 0,
  duplicateCheck: null,
  tagTransfer,
  removingFolders: 0,
});

describe('SettingsPage', () => {
  let fixture: ComponentFixture<SettingsPage>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  let roots: LibraryRoot[];
  let lastExport: TagExportRecord | null;
  let exportTags: DesktopBridge['exportTags'];

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  /** Shows Settings, as when going there (again). */
  const mount = async (): Promise<void> => {
    fixture = TestBed.createComponent(SettingsPage);
    host = fixture.nativeElement as HTMLElement;
    await render();
  };
  const text = (element: Element | null | undefined): string =>
    element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const button = (label: string, within: Element | null = host): HTMLButtonElement | undefined =>
    [...(within?.querySelectorAll('button') ?? [])].find((candidate) => text(candidate) === label);
  const askToRemove = async (root: LibraryRoot): Promise<HTMLElement | null> => {
    host.querySelector<HTMLButtonElement>(`[aria-label="Remove ${root.path}"]`)?.click();
    await render();
    return host.querySelector<HTMLElement>('.confirm');
  };

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    roots = [pictures, videos];
    worker.respond('listRoots', () => roots);
    worker.respond('getDiagnostics', () => ({
      ffmpeg: null,
      ffprobe: null,
      sqlite: '3.50.0',
      dataDir: '/Users/seb/Library/Application Support/SG Tag',
    }));
    worker.respond('listTags', () => []);
    lastExport = null;
    worker.respond('getLastTagExport', () => lastExport);
    worker.respond('removeRoot', () => undefined);
    exportTags = () => Promise.resolve(exported);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: WorkerClient, useValue: worker },
        { provide: DESKTOP, useValue: { ...fakeDesktop, exportTags: () => exportTags() } },
      ],
    });
    await mount();
  });

  it('puts the Tags section between Library folders and Diagnostics', () => {
    expect([...host.querySelectorAll('h2')].map((heading) => text(heading))).toEqual([
      'Library folders',
      'Tags',
      'Diagnostics',
    ]);
    expect(text(host.querySelector('app-tag-transfer .counts'))).toBe(
      '1,234 tagged files · 0 tags · Never exported',
    );
  });

  it('offers to export the tags before removing a folder that has some', async () => {
    const confirm = await askToRemove(pictures);
    expect(text(confirm?.querySelector('span'))).toBe(
      'Remove from the library? Tags on 1,234 files will be lost unless you export them first. Files on disk are not touched.',
    );
    expect(document.activeElement).toBe(button('Cancel', confirm));

    button('Export tags…', confirm)?.click();
    await render();
    expect(text(confirm?.querySelector('span'))).toBe(
      'Tags exported. Remove from the library? Files on disk are not touched.',
    );
    expect(button('Export tags…', confirm)).toBeUndefined();
    expect(text(host.querySelector('app-tag-transfer [role="status"]'))).toContain(
      'Exported the tags of 1,234 files',
    );
  });

  it('still warns that removing a folder loses the tags its tags export left out', async () => {
    exportTags = () => Promise.resolve({ ...exported, leftOut: 2 });
    let confirm = await askToRemove(pictures);
    button('Export tags…', confirm)?.click();
    await render();
    expect(text(confirm?.querySelector('span'))).toBe(
      'Tags exported, except 2 that a tags export cannot hold: removing the folder loses those on its files. Remove from the library? Files on disk are not touched.',
    );
    expect(button('Export tags…', confirm)).toBeUndefined();

    button('Cancel', confirm)?.click();
    await render();
    exportTags = () => Promise.resolve({ ...exported, leftOut: 1 });
    confirm = await askToRemove(pictures);
    button('Export tags…', confirm)?.click();
    await render();
    expect(text(confirm?.querySelector('span'))).toBe(
      'Tags exported, except 1 that a tags export cannot hold: removing the folder loses that one on its files. Remove from the library? Files on disk are not touched.',
    );

    // No file kept a tag the tags export can hold: it holds none of them.
    button('Cancel', confirm)?.click();
    await render();
    exportTags = () => Promise.resolve({ ...exported, files: 0, leftOut: 2 });
    confirm = await askToRemove(pictures);
    button('Export tags…', confirm)?.click();
    await render();
    expect(text(confirm?.querySelector('span'))).toBe(
      'No tags exported: a tags export cannot hold any of them, so removing the folder loses its tags. Remove from the library? Files on disk are not touched.',
    );
    expect(button('Export tags…', confirm)).toBeUndefined();
    button('Remove', confirm)?.click();
    await render();
    expect(worker.callsTo('removeRoot')).toEqual([[pictures.id]]);
  });

  it('asks only to confirm the removal of a folder without tags', async () => {
    const confirm = await askToRemove(videos);
    expect(text(confirm?.querySelector('span'))).toBe(
      'Remove from the library? Files on disk are not touched.',
    );
    expect(button('Export tags…', confirm)).toBeUndefined();

    button('Cancel', confirm)?.click();
    await render();
    expect(host.querySelector('.confirm')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(`[aria-label="Remove ${videos.path}"]`));
  });

  it('removes a folder only once the tags export under way is done', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    const confirm = await askToRemove(pictures);
    button('Export tags…', confirm)?.click();
    await render();
    const remove = button('Remove', confirm);
    expect(remove?.getAttribute('aria-disabled')).toBe('true');
    expect(text(confirm?.querySelector('span'))).toBe(
      'Exporting tags… Remove the folder once it is done. Files on disk are not touched.',
    );
    remove?.focus();
    remove?.click();
    await render();
    expect(worker.callsTo('removeRoot')).toHaveLength(0);
    expect(document.activeElement).toBe(remove);

    saving.resolve(exported);
    await render();
    expect(text(confirm?.querySelector('span'))).toBe(
      'Tags exported. Remove from the library? Files on disk are not touched.',
    );
    expect(remove?.hasAttribute('aria-disabled')).toBe(false);
    remove?.click();
    await render();
    expect(worker.callsTo('removeRoot')).toEqual([[pictures.id]]);
  });

  it('says why Remove waits for another export started once the tags were exported', async () => {
    const confirm = await askToRemove(pictures);
    button('Export tags…', confirm)?.click();
    await render();
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…', host.querySelector('app-tag-transfer'))?.click();
    await render();
    const remove = button('Remove', confirm);
    expect(remove?.getAttribute('aria-disabled')).toBe('true');
    expect(text(confirm?.querySelector('span'))).toBe(
      'Exporting tags… Remove the folder once it is done. Files on disk are not touched.',
    );

    saving.resolve(exported);
    await render();
    expect(text(confirm?.querySelector('span'))).toBe(
      'Tags exported. Remove from the library? Files on disk are not touched.',
    );
    expect(remove?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('exports no tags while a library folder is being removed, and says why', async () => {
    roots = [pictures, { ...videos, taggedCount: 12 }];
    worker.emit('rootsChanged', null);
    await render();
    const removing = Promise.withResolvers<undefined>();
    worker.respond('removeRoot', () => removing.promise);
    let exports = 0;
    exportTags = () => {
      exports++;
      return Promise.resolve(exported);
    };
    const reason = 'A library folder is being removed: export the tags once that is done.';
    button('Remove', await askToRemove(pictures))?.click();
    await render();
    expect(worker.callsTo('removeRoot')).toEqual([[pictures.id]]);

    const exportTagsButton = (): HTMLButtonElement | undefined =>
      button('Export tags…', host.querySelector('app-tag-transfer'));
    const hint = (): Element | null => host.querySelector('app-tag-transfer .hint');
    expect(exportTagsButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(text(hint())).toBe(reason);
    expect(exportTagsButton()?.getAttribute('aria-describedby')).toBe(hint()?.id);
    exportTagsButton()?.click();
    await render();
    expect(exports).toBe(0);

    // The other folder's confirmation still warns that its tags will be lost, and says why they
    // cannot be exported yet.
    const confirm = await askToRemove(videos);
    expect(text(confirm?.querySelector('span'))).toBe(
      `Remove from the library? Tags on 12 files will be lost unless you export them first. ${reason} Files on disk are not touched.`,
    );
    const exportFirst = button('Export tags…', confirm);
    expect(exportFirst?.getAttribute('aria-disabled')).toBe('true');
    exportFirst?.click();
    await render();
    expect(exports).toBe(0);
    expect(text(confirm?.querySelector('span'))).toContain('will be lost');

    // Leaving Settings does not end the removal.
    fixture.destroy();
    await mount();
    expect(exportTagsButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(text(hint())).toBe(reason);

    removing.resolve(undefined);
    await render();
    expect(exportTagsButton()?.hasAttribute('aria-disabled')).toBe(false);
    expect(hint()).toBeNull();
    exportTagsButton()?.click();
    await render();
    expect(exports).toBe(1);
  });

  it('exports no tags while a window closed since removes a library folder, and says why', async () => {
    roots = [pictures, { ...videos, taggedCount: 12 }];
    worker.emit('rootsChanged', null);
    await render();
    let exports = 0;
    exportTags = () => {
      exports++;
      return Promise.resolve(exported);
    };
    const reason = 'A library folder is being removed: export the tags once that is done.';
    // This window started no removal: only the indexer knows of it.
    worker.emit('status', { ...status(null), removingFolders: 1 });
    await render();

    const exportTagsButton = (): HTMLButtonElement | undefined =>
      button('Export tags…', host.querySelector('app-tag-transfer'));
    const hint = (): Element | null => host.querySelector('app-tag-transfer .hint');
    expect(exportTagsButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(text(hint())).toBe(reason);
    expect(exportTagsButton()?.getAttribute('aria-describedby')).toBe(hint()?.id);
    exportTagsButton()?.click();
    await render();
    expect(exports).toBe(0);

    const confirm = await askToRemove(videos);
    expect(text(confirm?.querySelector('span'))).toBe(
      `Remove from the library? Tags on 12 files will be lost unless you export them first. ${reason} Files on disk are not touched.`,
    );
    const exportFirst = button('Export tags…', confirm);
    expect(exportFirst?.getAttribute('aria-disabled')).toBe('true');
    exportFirst?.click();
    await render();
    expect(exports).toBe(0);

    worker.emit('status', status(null));
    await render();
    expect(exportFirst?.hasAttribute('aria-disabled')).toBe(false);
    expect(exportTagsButton()?.hasAttribute('aria-disabled')).toBe(false);
    expect(hint()).toBeNull();
    exportTagsButton()?.click();
    await render();
    expect(exports).toBe(1);
  });

  it('lets the export asked for by a removal finish after Settings was left', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    const confirm = await askToRemove(pictures);
    button('Export tags…', confirm)?.click();
    await render();
    fixture.destroy();

    saving.resolve(exported);
    await settle();
    await mount();
    expect(host.querySelector('.confirm')).toBeNull();
    expect(text(host.querySelector('app-tag-transfer [role="status"]'))).toBe(
      `Exported the tags of 1,234 files to ${exported.path}. Keep it with your backups.`,
    );
  });

  it('removes no folder while the indexer writes a tags export', async () => {
    worker.emit('status', status({ step: 'exporting', done: 4_000, total: 12_345 }));
    const confirm = await askToRemove(videos);
    expect(text(confirm?.querySelector('span'))).toBe(
      'Exporting tags… Remove the folder once it is done. Files on disk are not touched.',
    );
    const remove = button('Remove', confirm);
    expect(remove?.getAttribute('aria-disabled')).toBe('true');
    remove?.click();
    await render();
    expect(worker.callsTo('removeRoot')).toHaveLength(0);
  });

  it('says why an export failed after Settings was left and shown again', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…')?.click();
    await render();
    fixture.destroy();

    saving.reject(
      new Error(
        "Error invoking remote method 'tags:export': Error: The tags export could not be saved: that disk is read-only.",
      ),
    );
    await settle();
    await mount();
    expect(text(host.querySelector('app-tag-transfer [role="alert"]'))).toBe(
      'The tags export could not be saved: that disk is read-only.',
    );
  });

  it('shows an export still under way when Settings is shown again, then how it ended', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…')?.click();
    await render();
    fixture.destroy();

    await mount();
    expect(text(host.querySelector('app-tag-transfer [role="status"]'))).toBe('Exporting tags…');
    expect(button('Export tags…')?.getAttribute('aria-disabled')).toBe('true');
    expect(button('Import tags…')?.getAttribute('aria-disabled')).toBe('true');

    lastExport = { at: new Date(2026, 9, 19, 9).getTime(), path: exported.path, files: 1_234 };
    saving.resolve(exported);
    await render();
    expect(text(host.querySelector('app-tag-transfer [role="status"]'))).toBe(
      `Exported the tags of 1,234 files to ${exported.path}. Keep it with your backups.`,
    );
    expect(text(host.querySelector('app-tag-transfer .counts'))).toBe(
      '1,234 tagged files · 0 tags · Last exported on October 19, 2026',
    );
  });

  it('lists the library folders again when they change', async () => {
    expect(worker.callsTo('listRoots')).toHaveLength(1);
    roots = [{ ...pictures, taggedCount: 1_300 }];
    worker.emit('rootsChanged', null);
    await render();
    expect(worker.callsTo('listRoots')).toHaveLength(2);
    expect(host.querySelectorAll('.root')).toHaveLength(1);
    expect(text(host.querySelector('app-tag-transfer .counts'))).toContain('1,300 tagged files');
  });
});
