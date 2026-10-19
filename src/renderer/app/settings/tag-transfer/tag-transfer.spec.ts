import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { DesktopBridge } from '@shared/desktop-api';
import type {
  IndexStatus,
  Tag,
  TagExportRecord,
  TagExportResult,
  TagImportFolder,
  TagImportPreview,
  TagImportResult,
  TagImportSource,
  TagTransferProgress,
} from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../../testing/fake-worker-client';
import { TagTransfer } from './tag-transfer';

const DATA_DIR = '/Users/seb/Library/Application Support/SG Tag';
const EXPORT_PATH = '/Users/seb/Documents/SG Tag tags 2026-10-19.jsonl';

const tag = (id: number, path: string): Tag => ({
  id,
  path,
  name: path,
  parentId: null,
  fileCount: 1,
});

const source: TagImportSource = {
  token: 'token-1',
  name: 'SG Tag tags 2026-10-12.jsonl',
  exportedAt: '2026-10-12T12:00:00.000Z',
  platform: 'darwin',
  files: 5_214,
  tags: 87,
  invalid: 0,
  problems: [],
};

const preview: TagImportPreview = {
  planId: 1,
  found: { samePlace: 4_980, moved: 110, shared: 3 },
  changed: 9,
  notFound: { missing: 40, uncompared: 8, folder: 60, notFound: 4 },
  folders: [
    {
      exported: '/Users/seb/Pictures',
      files: 4_334,
      found: 4_322,
      foundIn: ['/Users/seb/Pictures'],
      inLibrary: true,
      suspicious: false,
      addable: false,
    },
    {
      exported: '/Volumes/Archive',
      files: 880,
      found: 0,
      foundIn: [],
      inLibrary: false,
      suspicious: false,
      addable: true,
    },
  ],
  movedItems: [{ exported: '/Users/seb/Pictures/a.jpg', current: '/Users/seb/Pictures/b.jpg' }],
  changedItems: [{ exported: '/Users/seb/Pictures/c.jpg', current: '/Users/seb/Pictures/c.jpg' }],
  missedItems: [{ exported: '/Volumes/Archive/d.jpg', reason: 'folder' }],
  additions: { assignments: 3_401, files: 2_971, newTags: 9 },
  additionsWithChanged: { assignments: 3_410, files: 2_980, newTags: 9 },
};

/** Everything found at its place, as when restoring on the same computer. */
const restore: TagImportPreview = {
  ...preview,
  found: { samePlace: 5_214, moved: 0, shared: 0 },
  changed: 0,
  notFound: { missing: 0, uncompared: 0, folder: 0, notFound: 0 },
  folders: [preview.folders[0]!],
  movedItems: [],
  changedItems: [],
  missedItems: [],
};

const result: TagImportResult = {
  assignments: 3_410,
  files: 2_980,
  newTags: 9,
  skipped: 3,
  notFound: 112,
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

describe('TagTransfer', () => {
  let fixture: ComponentFixture<TagTransfer>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  let lastExport: TagExportRecord | null;
  let exportTags: DesktopBridge['exportTags'];
  let openTagImport: DesktopBridge['openTagImport'];

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  /** Shows the Tags section, as when Settings is shown (again). */
  const mount = async (taggedFiles = 5_214): Promise<void> => {
    fixture = TestBed.createComponent(TagTransfer);
    fixture.componentRef.setInput('dataDir', DATA_DIR);
    fixture.componentRef.setInput('taggedFiles', taggedFiles);
    host = fixture.nativeElement as HTMLElement;
    await render();
  };
  const text = (element: Element | null | undefined = host): string =>
    element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((candidate) => text(candidate) === label);
  const labels = (): string[] => [...host.querySelectorAll('button')].map((each) => text(each));
  const progress = async (step: TagTransferProgress | null): Promise<void> => {
    worker.emit('status', status(step));
    await render();
  };
  const escape = (target: Element | null | undefined): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target?.dispatchEvent(event);
    return event;
  };
  /** Opens a tags export whose preview is `shown`. */
  const openPreview = async (shown: TagImportPreview = preview): Promise<void> => {
    openTagImport = () => Promise.resolve(source);
    worker.respond('planTagImport', () => shown);
    button('Import tags…')?.focus();
    button('Import tags…')?.click();
    await render();
  };

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    worker.respond('listTags', () => [tag(1, 'trips'), tag(2, 'family')]);
    lastExport = null;
    worker.respond('getLastTagExport', () => lastExport);
    worker.respond('closeTagImport', () => undefined);
    exportTags = () => Promise.resolve(null);
    openTagImport = () => Promise.resolve(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkerClient, useValue: worker },
        {
          provide: DESKTOP,
          useValue: {
            ...fakeDesktop,
            exportTags: () => exportTags(),
            openTagImport: () => openTagImport(),
          },
        },
      ],
    });
    await mount();
  });

  it('shows the data folder and the counts, never exported', () => {
    expect(text(host.querySelector('dd code'))).toBe(DATA_DIR);
    expect(text(host.querySelector('.counts'))).toBe(
      '5,214 tagged files · 2 tags · Never exported',
    );
  });

  it('says when the tags were last exported, and where to', async () => {
    lastExport = {
      at: new Date(2026, 9, 12, 9).getTime(),
      path: '/Volumes/Backup/SG Tag tags 2026-10-12.jsonl',
      files: 5_000,
    };
    fixture.destroy();
    await mount(1);

    expect(text(host.querySelector('.counts'))).toBe(
      '1 tagged file · 2 tags · Last exported on October 12, 2026',
    );
    expect(host.querySelector('.counts span')?.getAttribute('title')).toBe(lastExport.path);
  });

  it('keeps Export tags… focusable but inert when nothing is tagged, and says why', async () => {
    let exports = 0;
    exportTags = () => {
      exports++;
      return Promise.resolve(null);
    };
    fixture.componentRef.setInput('taggedFiles', 0);
    await render();

    const exportButton = button('Export tags…');
    expect(exportButton?.disabled).toBe(false);
    expect(exportButton?.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(exportButton?.getAttribute('aria-describedby') ?? '');
    expect(text(hint)).toBe('Nothing to export yet: no file is tagged.');
    exportButton?.focus();
    exportButton?.click();
    await render();
    expect(exports).toBe(0);
    expect(document.activeElement).toBe(exportButton);
  });

  it('keeps the focus on the busy buttons and shows the progress of an export', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    const exportButton = button('Export tags…');
    exportButton?.focus();
    exportButton?.click();
    await render();

    expect(exportButton?.getAttribute('aria-disabled')).toBe('true');
    expect(button('Import tags…')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(exportButton);
    expect(text(host.querySelector('[role="status"]'))).toBe('Exporting tags…');
    await progress({ step: 'exporting', done: 4_000, total: 12_345 });
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Exporting tags… 4,000 of 12,345 files',
    );

    await progress(null);
    saving.resolve({ path: EXPORT_PATH, files: 12_345, missing: 0, tags: 87, leftOut: 0 });
    await render();
    expect(exportButton?.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(exportButton);
  });

  it('says nothing when the save dialog is canceled', async () => {
    const saving = Promise.withResolvers<null>();
    exportTags = () => saving.promise;
    const exportButton = button('Export tags…');
    exportButton?.focus();
    exportButton?.click();
    await render();

    saving.resolve(null);
    await render();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(exportButton?.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(exportButton);
  });

  it('says where the tags were exported, and how many files were missing', async () => {
    const path = EXPORT_PATH;
    exportTags = () => Promise.resolve({ path, files: 12_345, missing: 0, tags: 87, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files to ${path}. Keep it with your backups.`,
    );
    expect(worker.callsTo('getLastTagExport')).toHaveLength(2);

    exportTags = () => Promise.resolve({ path, files: 12_345, missing: 12, tags: 87, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files (12 of them missing from disk) to ${path}. Keep it with your backups.`,
    );

    exportTags = () => Promise.resolve({ path, files: 1, missing: 1, tags: 1, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 1 file (missing from disk) to ${path}. Keep it with your backups.`,
    );
  });

  it('says how many tags the tags export could not hold, and every reason why', async () => {
    const path = EXPORT_PATH;
    const limits =
      'a tags export cannot hold tags longer than 1,024 characters, nested more than 64 levels deep, with more than 30 combining marks in a row, or past 1,000 on a file.';
    // Distinct tags: one on 1,203 files is left out once.
    exportTags = () => Promise.resolve({ path, files: 12_345, missing: 12, tags: 87, leftOut: 3 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files (12 of them missing from disk) to ${path}. Keep it with your backups. 3 tags could not be exported for some or all of their files: ${limits}`,
    );

    exportTags = () => Promise.resolve({ path, files: 1, missing: 0, tags: 2, leftOut: 1 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 1 file to ${path}. Keep it with your backups. 1 tag could not be exported for some or all of its files: ${limits}`,
    );
  });

  it('shows an export the indexer finished after restarting during the save dialog', async () => {
    const saving = Promise.withResolvers<TagExportResult | null>();
    exportTags = () => saving.promise;
    button('Export tags…')?.click();
    await render();
    worker.reconnect();
    await render();
    // Main runs the export on the new indexer once a file is chosen: it is still under way.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button('Export tags…')?.getAttribute('aria-disabled')).toBe('true');
    expect(button('Import tags…')?.getAttribute('aria-disabled')).toBe('true');

    lastExport = { at: new Date(2026, 9, 19, 9).getTime(), path: EXPORT_PATH, files: 12_345 };
    saving.resolve({ path: EXPORT_PATH, files: 12_345, missing: 0, tags: 87, leftOut: 0 });
    await render();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files to ${EXPORT_PATH}. Keep it with your backups.`,
    );
    expect(text(host.querySelector('.counts'))).toBe(
      '5,214 tagged files · 2 tags · Last exported on October 19, 2026',
    );
  });

  it('says the indexer restarted when it went away during the export', async () => {
    for (const reason of ['The indexer process exited', 'The indexer is not running']) {
      exportTags = () =>
        Promise.reject(new Error(`Error invoking remote method 'tags:export': Error: ${reason}`));
      button('Export tags…')?.click();
      await render();
      worker.reconnect();
      await render();
      expect(text(host.querySelector('[role="alert"]'))).toBe(
        'The indexer restarted during the export. Try again.',
      );
    }
  });

  it('shows why the tags were not exported, without the channel name', async () => {
    exportTags = () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'tags:export': Error: The tags export could not be saved: the disk is full.",
        ),
      );
    button('Export tags…')?.click();
    await render();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.classList).toContain('error');
    expect(text(alert)).toBe('The tags export could not be saved: the disk is full.');
  });

  it('shows the progress of reading and matching a tags export', async () => {
    const opening = Promise.withResolvers<TagImportSource | null>();
    openTagImport = () => opening.promise;
    worker.respond('planTagImport', () => new Promise<TagImportPreview>(() => undefined));
    button('Import tags…')?.click();
    await render();
    await progress({ step: 'reading', done: 45, total: 100 });
    expect(text(host.querySelector('[role="status"]'))).toBe('Reading the tags export… 45%');
    expect(button('Cancel')).toBeDefined();

    opening.resolve(source);
    await progress({ step: 'waiting', done: 0, total: 0 });
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Waiting for indexing to finish, so that every file can be found…',
    );
    await progress({ step: 'matching', done: 4_000, total: 5_214 });
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Looking for the 5,214 files of the tags export… 4,000 done',
    );
    await progress({ step: 'comparing', done: 40, total: 112 });
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Comparing contents… 40 of 112 files read',
    );
    expect(worker.callsTo('planTagImport')).toEqual([['token-1']]);
  });

  it('closes the tags export on Cancel, and ignores what the indexer answers next', async () => {
    const plan = Promise.withResolvers<TagImportPreview>();
    openTagImport = () => Promise.resolve(source);
    worker.respond('planTagImport', () => plan.promise);
    button('Import tags…')?.click();
    await render();

    button('Cancel')?.focus();
    button('Cancel')?.click();
    await render();
    expect(worker.callsTo('closeTagImport')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(document.activeElement).toBe(button('Import tags…'));

    plan.reject(new Error('Canceled.'));
    await render();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('closes the tags export on Escape, and gives the focus back to Import tags…', async () => {
    await openPreview();
    let escapes = 0;
    const countEscape = (): void => {
      escapes++;
    };
    document.addEventListener('keydown', countEscape);
    const event = escape(document.activeElement);
    document.removeEventListener('keydown', countEscape);
    await render();

    expect(event.defaultPrevented).toBe(true);
    expect(escapes).toBe(0);
    expect(worker.callsTo('closeTagImport')).toHaveLength(1);
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(document.activeElement).toBe(button('Import tags…'));
  });

  it('previews what importing adds, leaving out what is not there', async () => {
    await openPreview();
    const shown = host.querySelector('app-tag-import-preview');
    expect(shown?.getAttribute('role')).toBe('group');
    const heading = document.getElementById(shown?.getAttribute('aria-labelledby') ?? '');
    expect(text(heading)).toBe('Import tags from “SG Tag tags 2026-10-12.jsonl”?');
    for (const line of [
      'Exported on October 12, 2026 from a Mac · 5,214 tagged files · 87 tags',
      '5,093 of 5,214 files found.',
      '4,980 at the same place',
      '110 renamed or moved since the export, recognised by their content',
      '3 identical copies in the export were found as one file here, which gets the tags of each',
      'Also tag the 9 files at the same place that changed since the export, or could not be compared',
      '112 files not found: their tags are not imported.',
      '40 were already missing from disk when the tags export was made',
      '8 may be on a drive that is not connected: connect it, then check again',
      '60 were in a library folder that is not in this library',
      '4 were not found',
      '/Volumes/Archive/d.jpg folder not in this library',
      '/Users/seb/Pictures/a.jpg → /Users/seb/Pictures/b.jpg',
    ]) {
      expect(text(shown)).toContain(line);
    }
    const folders = [...(shown?.querySelectorAll('.folder') ?? [])].map((folder) =>
      [...folder.children].map((cell) => text(cell)),
    );
    expect(folders).toEqual([
      ['/Users/seb/Pictures', 'found in /Users/seb/Pictures', '4,322 of 4,334'],
      [
        '/Volumes/Archive',
        'not in this library',
        '0 of 880',
        'This folder exists on this computer. Add as library folder',
      ],
    ]);
    expect(text(shown?.querySelector('.summary'))).toBe(
      'Importing adds 3,410 tags to 2,980 files, and creates 9 new tags.',
    );

    await openPreview(restore);
    const restored = text(host.querySelector('app-tag-import-preview'));
    expect(restored).toContain('5,214 of 5,214 files found.');
    expect(restored).not.toContain('renamed or moved');
    expect(restored).not.toContain('identical copies');
    expect(restored).not.toContain('not found');
    expect(restored).not.toContain('could not be read');
    expect(restored).not.toContain('Library folders in the tags export');
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('says which lines could not be read in full, a line that lost a tag being still imported', async () => {
    const problems = ['Line 3: invalid path.', 'Line 7: a tag was left out.'];
    openTagImport = () => Promise.resolve({ ...source, invalid: 2, problems });
    worker.respond('planTagImport', () => preview);
    button('Import tags…')?.click();
    await render();

    const shown = host.querySelector('app-tag-import-preview');
    expect(text(shown)).toContain(
      '2 lines of the tags export could not be read in full: what could not be read is left out.',
    );
    const why = shown?.querySelector('[aria-label="Lines not read in full"]');
    expect([...(why?.children ?? [])].map((line) => text(line))).toEqual(problems);
  });

  it('focuses Import tags, described by what it adds', async () => {
    await openPreview();
    const importButton = button('Import tags');
    expect(document.activeElement).toBe(importButton);
    const summary = document.getElementById(importButton?.getAttribute('aria-describedby') ?? '');
    expect(text(summary)).toBe('Importing adds 3,410 tags to 2,980 files, and creates 9 new tags.');
  });

  it('imports the changed files only if asked to', async () => {
    worker.respond('applyTagImport', () => new Promise<TagImportResult>(() => undefined));
    await openPreview();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    checkbox?.click();
    await render();
    expect(text(host.querySelector('.summary'))).toBe(
      'Importing adds 3,401 tags to 2,971 files, and creates 9 new tags.',
    );

    button('Import tags')?.click();
    await render();
    expect(worker.callsTo('applyTagImport')).toEqual([['token-1', 1, false]]);
  });

  it('offers only Check again and Close when there is nothing to add', async () => {
    const nothingToAdd: TagImportPreview = {
      ...restore,
      additions: { assignments: 0, files: 0, newTags: 0 },
      additionsWithChanged: { assignments: 0, files: 0, newTags: 0 },
    };
    await openPreview(nothingToAdd);
    expect(text(host.querySelector('.summary'))).toBe(
      'Nothing to add: the files found already have all these tags.',
    );
    expect(labels()).toEqual(['Export tags…', 'Import tags…', 'Check again', 'Close']);
    expect(document.activeElement).toBe(button('Close'));

    await openPreview({
      ...nothingToAdd,
      found: { samePlace: 0, moved: 0, shared: 0 },
      notFound: { missing: 0, uncompared: 0, folder: 5_214, notFound: 0 },
    });
    expect(text(host.querySelector('.summary'))).toBe(
      'None of these files were found in your library folders. Add the folders that hold them, here or in Library folders, then check again.',
    );
    expect(labels()).toEqual(['Export tags…', 'Import tags…', 'Check again', 'Close']);

    button('Close')?.click();
    await render();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(worker.callsTo('closeTagImport').length).toBeGreaterThan(0);
  });

  it('adds a library folder, starting nothing else meanwhile, then checks again', async () => {
    const adding = Promise.withResolvers<undefined>();
    worker.respond('addRoot', async (path) => {
      await adding.promise;
      return { id: 2, path, online: true, fileCount: 0, taggedCount: 0 };
    });
    let exports = 0;
    exportTags = () => {
      exports++;
      return Promise.resolve(null);
    };
    await openPreview();
    const add = button('Add as library folder');
    add?.click();
    await render();
    expect(worker.callsTo('addRoot')).toEqual([['/Volumes/Archive']]);
    expect(text(add)).toBe('Adding…');
    for (const label of ['Export tags…', 'Import tags…', 'Check again', 'Adding…', 'Import tags']) {
      expect(button(label)?.getAttribute('aria-disabled')).toBe('true');
      button(label)?.click();
    }
    await render();
    expect(exports).toBe(0);
    expect(worker.callsTo('addRoot')).toHaveLength(1);
    expect(worker.callsTo('planTagImport')).toHaveLength(1);
    expect(worker.callsTo('applyTagImport')).toHaveLength(0);

    adding.resolve(undefined);
    await render();
    expect(worker.callsTo('planTagImport')).toEqual([['token-1'], ['token-1']]);
  });

  it('shows why a library folder could not be added', async () => {
    worker.respond('addRoot', () => Promise.reject(new Error('This folder is already indexed.')));
    await openPreview();
    button('Add as library folder')?.click();
    await render();
    expect(text(host.querySelector('.folder [role="alert"]'))).toBe(
      'This folder is already indexed.',
    );
    expect(worker.callsTo('planTagImport')).toHaveLength(1);
  });

  it('lets an import under way finish, whatever the keys pressed', async () => {
    const applying = Promise.withResolvers<TagImportResult>();
    worker.respond('applyTagImport', () => applying.promise);
    await openPreview();
    const importButton = button('Import tags');
    importButton?.click();
    await render();
    await progress({ step: 'importing', done: 1_200, total: 2_980 });
    expect(text(host.querySelector('.activity'))).toBe('Importing tags… 1,200 of 2,980 files');
    expect(importButton?.getAttribute('aria-disabled')).toBe('true');
    expect(button('Check again')?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(importButton);
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.getAttribute('aria-disabled')).toBe('true');
    expect(getComputedStyle(checkbox?.closest('label') ?? host).opacity).toBe('0.5');
    checkbox?.click();
    await render();
    expect(checkbox?.checked).toBe(true);

    const event = escape(importButton);
    await render();
    expect(event.defaultPrevented).toBe(true);
    expect(worker.callsTo('closeTagImport')).toHaveLength(0);
    expect(host.querySelector('app-tag-import-preview')).not.toBeNull();

    applying.resolve(result);
    await render();
    expect(document.activeElement).toBe(button('Import tags…'));
  });

  it('says what was added, what was not found and what was left out', async () => {
    worker.respond('applyTagImport', () => result);
    await openPreview();
    button('Import tags')?.click();
    await render();
    const done = text(host.querySelector('[role="status"]'));
    expect(done).toContain('Added 3,410 tags to 2,980 files, and created 9 new tags.');
    expect(done).toContain(
      '112 files of the tags export were not found, so their tags were not imported. Import the same tags export again once they are in your library folders: tags already imported are skipped.',
    );
    expect(done).toContain(
      '3 files changed or left the library during the import and were left out: import the tags export again to include them.',
    );
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(worker.callsTo('applyTagImport')).toEqual([['token-1', 1, true]]);
  });

  it('says nothing was added, and why, when every file was left out', async () => {
    const none = { assignments: 0, files: 0, newTags: 0, skipped: 0, notFound: 0 };
    worker.respond('applyTagImport', () => none);
    await openPreview();
    button('Import tags')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Nothing was added: the files already have these tags.',
    );

    worker.respond('applyTagImport', () => ({ ...none, skipped: 3 }));
    await openPreview();
    button('Import tags')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Nothing was added. 3 files changed or left the library during the import and were left out: import the tags export again to include them.',
    );
  });

  it('offers to check again after a failed import only while the tags export is open', async () => {
    // The indexer keeps the tags export open when an import stops partway.
    worker.respond('applyTagImport', () => Promise.reject(new Error('database or disk is full')));
    await openPreview();
    button('Import tags')?.click();
    await render();
    expect([...host.querySelectorAll('[role="alert"] p')].map((each) => text(each))).toEqual([
      'database or disk is full',
      'The tags added before the import stopped are kept: check again to import the rest.',
    ]);
    button('Check again')?.click();
    await render();
    expect(worker.callsTo('planTagImport')).toEqual([['token-1'], ['token-1']]);
    expect(host.querySelector('app-tag-import-preview')).not.toBeNull();

    worker.respond('applyTagImport', () =>
      Promise.reject(new Error('This preview is out of date: check again.')),
    );
    button('Import tags')?.click();
    await render();
    expect(text(host.querySelector('[role="alert"]'))).toBe(
      'This preview is out of date: check again.',
    );
    button('Check again')?.click();
    await render();
    expect(worker.callsTo('planTagImport')).toHaveLength(3);
    expect(host.querySelector('app-tag-import-preview')).not.toBeNull();

    // Closed meanwhile, from another window: only choosing it again can work.
    worker.respond('applyTagImport', () =>
      Promise.reject(new Error('This tags export is no longer open: choose it again.')),
    );
    button('Import tags')?.click();
    await render();
    expect(text(host.querySelector('[role="alert"]'))).toBe(
      'This tags export is no longer open: choose it again.',
    );
    expect(button('Check again')).toBeUndefined();
    expect(button('Close')).toBeUndefined();

    worker.respond('applyTagImport', () => Promise.reject(new Error('database or disk is full')));
    await openPreview();
    button('Import tags')?.click();
    await render();
    worker.respond('planTagImport', () =>
      Promise.reject(new Error('This tags export is no longer open: choose it again.')),
    );
    button('Check again')?.click();
    await render();
    expect(text(host.querySelector('[role="alert"]'))).toBe(
      'This tags export is no longer open: choose it again.',
    );
    expect(button('Check again')).toBeUndefined();
  });

  it('starts over when the indexer restarts', async () => {
    await openPreview();
    worker.reconnect();
    await render();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(text(host.querySelector('[role="alert"]'))).toBe(
      'The indexer restarted. Open the tags export again.',
    );
    expect(button('Check again')).toBeUndefined();

    // While importing: the call fails as its connection is replaced.
    worker.respond('applyTagImport', () => {
      worker.reconnect();
      return Promise.reject(new Error('The indexer connection was replaced'));
    });
    await openPreview();
    button('Import tags')?.click();
    await render();
    expect(text(host.querySelector('[role="alert"]'))).toBe(
      'The indexer restarted. Open the tags export again.',
    );
  });

  it('previews a tags export the restarted indexer opened', async () => {
    const opening = Promise.withResolvers<TagImportSource | null>();
    openTagImport = () => opening.promise;
    worker.respond('planTagImport', () => preview);
    button('Import tags…')?.click();
    await render();
    worker.reconnect();
    await render();
    expect(host.querySelector('[role="alert"]')).toBeNull();

    // Main asks the new indexer to read the file chosen.
    opening.resolve(source);
    await render();
    expect(host.querySelector('app-tag-import-preview')).not.toBeNull();
    expect(worker.callsTo('planTagImport')).toEqual([['token-1']]);
    expect(worker.callsTo('closeTagImport')).toHaveLength(0);
  });

  it('closes the tags export when leaving', async () => {
    await openPreview();
    fixture.destroy();
    expect(worker.callsTo('closeTagImport')).toHaveLength(1);

    await mount();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(button('Import tags…')?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('says how an import ended when Settings is shown again after leaving it', async () => {
    const applying = Promise.withResolvers<TagImportResult>();
    worker.respond('applyTagImport', () => applying.promise);
    await openPreview();
    button('Import tags')?.click();
    await render();
    fixture.destroy();
    expect(worker.callsTo('closeTagImport')).toHaveLength(0);

    await mount();
    await progress({ step: 'importing', done: 1_200, total: 2_980 });
    expect(text(host.querySelector('.activity'))).toBe('Importing tags… 1,200 of 2,980 files');
    expect(button('Import tags…')?.getAttribute('aria-disabled')).toBe('true');
    fixture.destroy();

    applying.resolve(result);
    await settle();
    await mount();
    expect(text(host.querySelector('[role="status"]'))).toContain(
      'Added 3,410 tags to 2,980 files, and created 9 new tags.',
    );
  });

  it('starts nothing while the indexer exports or imports for a window closed since', async () => {
    let dialogs = 0;
    exportTags = () => {
      dialogs++;
      return Promise.resolve(null);
    };
    openTagImport = () => {
      dialogs++;
      return Promise.resolve(null);
    };
    const tryBoth = async (): Promise<void> => {
      for (const label of ['Export tags…', 'Import tags…']) {
        expect(button(label)?.getAttribute('aria-disabled')).toBe('true');
        button(label)?.click();
      }
      await render();
    };

    await progress({ step: 'importing', done: 1_300, total: 20_000 });
    expect(text(host.querySelector('.activity'))).toBe('Importing tags… 1,300 of 20,000 files');
    await tryBoth();
    await progress({ step: 'exporting', done: 4_000, total: 12_345 });
    expect(text(host.querySelector('.activity'))).toBe('Exporting tags… 4,000 of 12,345 files');
    await tryBoth();
    expect(dialogs).toBe(0);

    // That export ended: it may have been saved.
    lastExport = { at: new Date(2026, 9, 19, 9).getTime(), path: EXPORT_PATH, files: 12_345 };
    await progress(null);
    expect(host.querySelector('.activity')).toBeNull();
    expect(text(host.querySelector('.counts'))).toBe(
      '5,214 tagged files · 2 tags · Last exported on October 19, 2026',
    );
    expect(button('Export tags…')?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('keeps the preview as it was when the open dialog is canceled', async () => {
    await openPreview();
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    await render();
    let choosing = Promise.withResolvers<TagImportSource | null>();
    openTagImport = () => choosing.promise;
    const importButton = button('Import tags…');
    importButton?.focus();
    importButton?.click();
    await render();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();

    choosing.resolve(null);
    await render();
    expect(host.querySelector('app-tag-import-preview')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(document.activeElement).toBe(importButton);
    expect(worker.callsTo('closeTagImport')).toHaveLength(0);
    expect(worker.callsTo('planTagImport')).toHaveLength(1);

    // Unless the indexer restarted meanwhile: it no longer holds that tags export.
    choosing = Promise.withResolvers<TagImportSource | null>();
    importButton?.click();
    await render();
    worker.reconnect();
    await render();
    choosing.resolve(null);
    await render();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(text(host.querySelector('[role="alert"]'))).toBe(
      'The indexer restarted. Open the tags export again.',
    );
  });

  it('names no computer it does not know, whatever the tags export says', async () => {
    openTagImport = () => Promise.resolve({ ...source, platform: 'constructor' });
    worker.respond('planTagImport', () => preview);
    button('Import tags…')?.click();
    await render();
    expect(text(host.querySelector('app-tag-import-preview .about'))).toBe(
      'Exported on October 12, 2026 · 5,214 tagged files · 87 tags',
    );
  });

  it('tells a library folder where nothing was found from one not in this library', async () => {
    const empty = (exported: string, inLibrary: boolean): TagImportFolder => ({
      exported,
      files: 40,
      found: 0,
      foundIn: [],
      inLibrary,
      suspicious: false,
      addable: false,
    });
    fixture.componentRef.setInput('offlineFolders', new Set(['/Volumes/Archive']));
    await openPreview({
      ...preview,
      folders: [
        { ...empty('/Volumes/NO NAME', true), suspicious: true },
        empty('/Volumes/Archive', true),
        empty('/Volumes/Old', false),
      ],
    });
    const folders = [...host.querySelectorAll('.folder')].map((folder) =>
      [...folder.children].slice(0, 3).map((cell) => text(cell)),
    );
    expect(folders).toEqual([
      ['/Volumes/NO NAME', 'none found here', '0 of 40'],
      ['/Volumes/Archive', 'none found here · offline', '0 of 40'],
      ['/Volumes/Old', 'not in this library', '0 of 40'],
    ]);
  });

  it('says how many files the lists leave out', async () => {
    await openPreview();
    const ends = (): string[] =>
      [...host.querySelectorAll('app-tag-import-preview .paths')].map((list) =>
        text(list.lastElementChild),
      );
    expect(ends()).toEqual(['… and 109 more', '… and 8 more', '… and 111 more']);

    await openPreview({
      ...preview,
      found: { ...preview.found, moved: 1 },
      changed: 1,
      notFound: { missing: 0, uncompared: 0, folder: 1, notFound: 0 },
    });
    expect(host.querySelector('.more')).toBeNull();
  });

  it('never shows a preview that is out of date', async () => {
    const plans: PromiseWithResolvers<TagImportPreview>[] = [];
    openTagImport = () => Promise.resolve(source);
    worker.respond('planTagImport', () => {
      const plan = Promise.withResolvers<TagImportPreview>();
      plans.push(plan);
      return plan.promise;
    });
    button('Import tags…')?.click();
    await render();
    button('Cancel')?.click();
    await render();
    button('Import tags…')?.click();
    await render();

    plans[0]?.resolve(preview);
    await render();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    plans[1]?.resolve({ ...preview, planId: 2 });
    await render();
    worker.respond('applyTagImport', () => result);
    button('Import tags')?.click();
    await render();
    expect(worker.callsTo('applyTagImport')).toEqual([['token-1', 2, true]]);
  });
});
