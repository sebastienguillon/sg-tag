import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { DesktopBridge } from '@shared/desktop-api';
import type {
  CatalogueImportDetails,
  CatalogueStatus,
  IndexStatus,
  Tag,
  TagExportRecord,
  TagExportResult,
  TagImportDefinitions,
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

const tag = (id: number, name: string): Tag => ({
  id,
  name,
  aliases: [],
  parentIds: [],
  fileCount: 1,
});

const source: TagImportSource = {
  token: 'token-1',
  kind: 'tags',
  name: 'SG Tag tags 2026-10-12.jsonl',
  exportedAt: '2026-10-12T12:00:00.000Z',
  platform: 'darwin',
  files: 5_214,
  tags: 87,
  invalid: 0,
  problems: [],
  tagStudio: null,
  catalogue: null,
};

/** A tags export that describes no tag, or one whose tags are all here as it describes them. */
const noDefinitions: TagImportDefinitions = {
  created: 0,
  aliases: 0,
  links: 0,
  skipped: 0,
  createdItems: [],
  aliasItems: [],
  linkItems: [],
  knownAs: 0,
  knownAsItems: [],
  skippedItems: [],
};

const preview: TagImportPreview = {
  planId: 1,
  found: { samePlace: 4_980, moved: 110, shared: 3 },
  changed: 9,
  notFound: { missing: 40, uncompared: 8, folder: 60, ambiguous: 0, notMedia: 0, notFound: 4 },
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
  definitions: noDefinitions,
};

/** Everything found at its place, as when restoring on the same computer. */
const restore: TagImportPreview = {
  ...preview,
  found: { samePlace: 5_214, moved: 0, shared: 0 },
  changed: 0,
  notFound: { missing: 0, uncompared: 0, folder: 0, ambiguous: 0, notMedia: 0, notFound: 0 },
  folders: [preview.folders[0]!],
  movedItems: [],
  changedItems: [],
  missedItems: [],
};

/** What a tags export of a library with aliases and parent tags adds here. */
const definitions: TagImportDefinitions = {
  created: 4,
  aliases: 2,
  links: 5,
  skipped: 5,
  createdItems: ['France', 'Europe', 'To sort'],
  aliasItems: [
    { tag: 'Paris', alias: 'Paname' },
    { tag: 'France', alias: 'Hexagone' },
  ],
  linkItems: [
    { tag: 'Paris', parent: 'France', newlyFound: 1_200 },
    { tag: 'Lyon', parent: 'France', newlyFound: 1 },
    // France is made by the import, or the files of Rome are found under Europe already.
    { tag: 'France', parent: 'Europe', newlyFound: null },
    { tag: 'Rome', parent: 'Europe', newlyFound: 0 },
  ],
  knownAs: 1,
  knownAsItems: [{ exported: 'Paris', tag: 'Lutetia' }],
  skippedItems: [
    { kind: 'aliasTaken', tag: 'Lyon', alias: 'Gones', owner: 'Rhone' },
    { kind: 'aliasLimit', tag: 'Rome', alias: 'Urbs' },
    { kind: 'loop', tag: 'Europe', parent: 'Paris' },
    { kind: 'parentLimit', tag: 'Nice', parent: 'Provence' },
  ],
};

/** A tags export that lists no file, only tags. */
const tagsOnly: TagImportSource = { ...source, files: 0, tags: 6 };
const tagsOnlyPreview: TagImportPreview = {
  ...restore,
  found: { samePlace: 0, moved: 0, shared: 0 },
  folders: [],
  additions: { assignments: 0, files: 0, newTags: 0 },
  additionsWithChanged: { assignments: 0, files: 0, newTags: 0 },
  definitions: { ...noDefinitions, created: 1, links: 1 },
};

const result: TagImportResult = {
  assignments: 3_410,
  files: 2_980,
  newTags: 9,
  skipped: 3,
  notFound: 112,
  definitions: { created: 0, aliases: 0, links: 0, skipped: 0 },
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
  let openTagStudioImport: DesktopBridge['openTagStudioImport'];

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
  /** Opens a tags export, `opened`, whose preview is `shown`. */
  const openPreview = async (
    shown: TagImportPreview = preview,
    opened: TagImportSource = source,
  ): Promise<void> => {
    openTagImport = () => Promise.resolve(opened);
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
    worker.respond('getCatalogue', () => null);
    exportTags = () => Promise.resolve(null);
    openTagImport = () => Promise.resolve(null);
    openTagStudioImport = () => Promise.resolve(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkerClient, useValue: worker },
        {
          provide: DESKTOP,
          useValue: {
            ...fakeDesktop,
            exportTags: () => exportTags(),
            openTagImport: () => openTagImport(),
            openTagStudioImport: () => openTagStudioImport(),
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

  it('keeps Export tags… focusable but inert when there is no tag, and says why', async () => {
    let exports = 0;
    exportTags = () => {
      exports++;
      return Promise.resolve(null);
    };
    worker.respond('listTags', () => []);
    worker.emit('tagsChanged', null);
    fixture.componentRef.setInput('taggedFiles', 0);
    await render();

    const exportButton = button('Export tags…');
    expect(exportButton?.disabled).toBe(false);
    expect(exportButton?.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(exportButton?.getAttribute('aria-describedby') ?? '');
    expect(text(hint)).toBe('Nothing to export yet: there is no tag.');
    exportButton?.focus();
    exportButton?.click();
    await render();
    expect(exports).toBe(0);
    expect(document.activeElement).toBe(exportButton);
  });

  it('exports the tags when no file is tagged: a tag made on purpose is kept without one', async () => {
    let exports = 0;
    exportTags = () => {
      exports++;
      return Promise.resolve({
        path: EXPORT_PATH,
        files: 0,
        missing: 0,
        tags: 2,
        definitions: 2,
        leftOut: 0,
      });
    };
    fixture.componentRef.setInput('taggedFiles', 0);
    await render();

    const exportButton = button('Export tags…');
    expect(exportButton?.hasAttribute('aria-disabled')).toBe(false);
    expect(exportButton?.hasAttribute('aria-describedby')).toBe(false);
    expect(host.querySelector('.hint')).toBeNull();
    exportButton?.click();
    await render();
    expect(exports).toBe(1);
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported 2 tags with their aliases and parent tags to ${EXPORT_PATH}. Keep it with your backups.`,
    );

    exportTags = () =>
      Promise.resolve({
        path: EXPORT_PATH,
        files: 0,
        missing: 0,
        tags: 1,
        definitions: 1,
        leftOut: 0,
      });
    exportButton?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported 1 tag with its aliases and parent tags to ${EXPORT_PATH}. Keep it with your backups.`,
    );
  });

  it('says nothing of a tag to export until the tags are listed', async () => {
    const listing = Promise.withResolvers<Tag[]>();
    worker.respond('listTags', () => listing.promise);
    // The indexer restarted: the tags are listed again.
    worker.reconnect();
    fixture.componentRef.setInput('taggedFiles', 0);
    // Not `whenStable`: it waits for the tags to be listed.
    await settle();
    fixture.detectChanges();
    expect(button('Export tags…')?.hasAttribute('aria-disabled')).toBe(false);
    expect(host.querySelector('.hint')).toBeNull();

    listing.resolve([]);
    await render();
    expect(button('Export tags…')?.getAttribute('aria-disabled')).toBe('true');
    expect(text(host.querySelector('.hint'))).toBe('Nothing to export yet: there is no tag.');
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
    saving.resolve({
      path: EXPORT_PATH,
      files: 12_345,
      missing: 0,
      tags: 87,
      definitions: 0,
      leftOut: 0,
    });
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
    exportTags = () =>
      Promise.resolve({ path, files: 12_345, missing: 0, tags: 87, definitions: 0, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files to ${path}. Keep it with your backups.`,
    );
    expect(worker.callsTo('getLastTagExport')).toHaveLength(2);

    exportTags = () =>
      Promise.resolve({ path, files: 12_345, missing: 12, tags: 87, definitions: 0, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files (12 of them missing from disk) to ${path}. Keep it with your backups.`,
    );

    exportTags = () =>
      Promise.resolve({ path, files: 1, missing: 1, tags: 1, definitions: 0, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 1 file (missing from disk) to ${path}. Keep it with your backups.`,
    );
  });

  it('says how many tags were exported with their aliases and parent tags', async () => {
    const path = EXPORT_PATH;
    exportTags = () =>
      Promise.resolve({ path, files: 12_345, missing: 12, tags: 87, definitions: 40, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files (12 of them missing from disk) and the aliases and parent tags of 40 tags to ${path}. Keep it with your backups.`,
    );

    exportTags = () =>
      Promise.resolve({ path, files: 1, missing: 0, tags: 2, definitions: 1, leftOut: 0 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 1 file and the aliases and parent tags of 1 tag to ${path}. Keep it with your backups.`,
    );
  });

  it('says how many tags the tags export could not hold, and why', async () => {
    const path = EXPORT_PATH;
    const limits = 'a tags export cannot hold more than 1,000 tags on one file.';
    // Distinct tags: one on 1,203 files is left out once.
    exportTags = () =>
      Promise.resolve({ path, files: 12_345, missing: 12, tags: 87, definitions: 0, leftOut: 3 });
    button('Export tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      `Exported the tags of 12,345 files (12 of them missing from disk) to ${path}. Keep it with your backups. 3 tags could not be exported for some or all of their files: ${limits}`,
    );

    exportTags = () =>
      Promise.resolve({ path, files: 1, missing: 0, tags: 2, definitions: 0, leftOut: 1 });
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
    saving.resolve({
      path: EXPORT_PATH,
      files: 12_345,
      missing: 0,
      tags: 87,
      definitions: 0,
      leftOut: 0,
    });
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
    expect(labels()).toEqual([
      'Export tags…',
      'Import tags…',
      'Import from TagStudio…',
      'Import from catalogue…',
      'Check again',
      'Close',
    ]);
    expect(document.activeElement).toBe(button('Close'));

    await openPreview({
      ...nothingToAdd,
      found: { samePlace: 0, moved: 0, shared: 0 },
      notFound: {
        missing: 0,
        uncompared: 0,
        folder: 5_214,
        ambiguous: 0,
        notMedia: 0,
        notFound: 0,
      },
    });
    expect(text(host.querySelector('.summary'))).toBe(
      'None of these files were found in your library folders. Add the folders that hold them, here or in Library folders, then check again.',
    );
    expect(labels()).toEqual([
      'Export tags…',
      'Import tags…',
      'Import from TagStudio…',
      'Import from catalogue…',
      'Check again',
      'Close',
    ]);

    button('Close')?.click();
    await render();
    expect(host.querySelector('app-tag-import-preview')).toBeNull();
    expect(worker.callsTo('closeTagImport').length).toBeGreaterThan(0);
  });

  it('previews the tags, aliases and parent tags importing adds, and what it leaves out', async () => {
    await openPreview({ ...preview, definitions });
    const shown = host.querySelector('app-tag-import-preview');
    const section = [...(shown?.querySelectorAll('h4') ?? [])].find(
      (heading) => text(heading) === 'Aliases and parent tags',
    );
    // Each count without the items that its Show lists.
    const counts = [...(section?.nextElementSibling?.children ?? [])].map((line) =>
      (line.firstChild?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(counts).toEqual([
      '4 tags created',
      '2 aliases added',
      '5 parent tags added',
      '1 tag known here under another name',
      '5 left out',
    ]);
    const items = (label: string): string[] =>
      [...(shown?.querySelector(`[aria-label="${label}"]`)?.children ?? [])].map((item) =>
        text(item),
      );
    expect(items('Tags created')).toEqual(['France', 'Europe', 'To sort', '… and 1 more']);
    expect(items('Aliases added')).toEqual(['Paname → Paris', 'Hexagone → France']);
    expect(items('Parent tags added')).toEqual([
      'Paris under France · a search for France finds 1,200 more files',
      'Lyon under France · a search for France finds 1 more file',
      'France under Europe',
      'Rome under Europe',
      '… and 1 more',
    ]);
    expect(items('Tags known here under another name')).toEqual([
      'Paris is known here as Lutetia: Paris becomes one of its aliases',
    ]);
    expect(items('Aliases and parent tags left out')).toEqual([
      'Gones as an alias of Lyon · already a name of Rhone',
      'Urbs as an alias of Rome · Rome would have more than 100 aliases',
      'Paris as a parent tag of Europe · would make a loop',
      'Provence as a parent tag of Nice · Nice would have more than 100 parent tags',
      '… and 1 more',
    ]);
    // The tags described are made whether or not a file gets them, the others with their files.
    expect(text(shown?.querySelector('.summary'))).toBe(
      'Importing adds 3,410 tags to 2,980 files, creates 13 new tags, and adds 2 aliases and 5 parent tags.',
    );

    // Only what is there is said.
    await openPreview({
      ...preview,
      definitions: { ...noDefinitions, aliases: 1, aliasItems: [definitions.aliasItems[0]!] },
    });
    const only = host.querySelector('app-tag-import-preview');
    expect(text(only)).toContain('1 alias added');
    for (const absent of ['created', 'parent tags added', 'known here', 'left out']) {
      expect(text(only)).not.toContain(absent);
    }
    expect(text(only?.querySelector('.summary'))).toBe(
      'Importing adds 3,410 tags to 2,980 files, creates 9 new tags, and adds 1 alias.',
    );
    await openPreview(preview);
    expect(text(host.querySelector('app-tag-import-preview'))).not.toContain(
      'Aliases and parent tags',
    );
  });

  it('imports a tags export that lists no file, only tags', async () => {
    worker.respond('applyTagImport', () => ({
      ...result,
      assignments: 0,
      files: 0,
      newTags: 0,
      skipped: 0,
      notFound: 0,
      definitions: { created: 1, aliases: 0, links: 1, skipped: 0 },
    }));
    const planned = Promise.withResolvers<TagImportPreview>();
    openTagImport = () => Promise.resolve(tagsOnly);
    worker.respond('planTagImport', () => planned.promise);
    button('Import tags…')?.focus();
    button('Import tags…')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Checking the tags of the tags export…',
    );

    planned.resolve(tagsOnlyPreview);
    await render();
    const shown = host.querySelector('app-tag-import-preview');
    expect(text(shown?.querySelector('.about'))).toBe(
      'Exported on October 12, 2026 from a Mac · 6 tags',
    );
    expect(text(shown)).toContain(
      'This tags export lists no file, only tags with their aliases and parent tags. No tag is removed or renamed.',
    );
    for (const absent of [
      'Tags are added to files',
      'found',
      'Library folders in the tags export',
    ]) {
      expect(text(shown)).not.toContain(absent);
    }
    // Only the counts of the tags it describes: no list of files, not even an empty one.
    expect(shown?.querySelectorAll('.counts')).toHaveLength(1);
    expect(shown?.querySelector('h4 + .counts')).not.toBeNull();
    expect(text(shown?.querySelector('.summary'))).toBe(
      'Importing creates 1 new tag, and adds 1 parent tag.',
    );
    expect(labels()).toEqual([
      'Export tags…',
      'Import tags…',
      'Import from TagStudio…',
      'Import from catalogue…',
      'Check again',
      'Cancel',
      'Import tags',
    ]);
    expect(document.activeElement).toBe(button('Import tags'));

    button('Import tags')?.click();
    await render();
    expect(worker.callsTo('applyTagImport')).toEqual([['token-1', 1, true]]);
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Created 1 new tag, and added 1 parent tag.',
    );
  });

  it('imports aliases and parent tags although no file gets a tag', async () => {
    const aliasesOnly: TagImportPreview = {
      ...restore,
      additions: { assignments: 0, files: 0, newTags: 0 },
      additionsWithChanged: { assignments: 0, files: 0, newTags: 0 },
      definitions: { ...noDefinitions, aliases: 2, links: 1 },
    };
    worker.respond('applyTagImport', () => ({
      ...result,
      assignments: 0,
      files: 0,
      newTags: 0,
      skipped: 0,
      notFound: 0,
      definitions: { created: 0, aliases: 2, links: 1, skipped: 0 },
    }));
    await openPreview(aliasesOnly);
    expect(text(host.querySelector('.summary'))).toBe(
      'The files found already have all these tags. Importing adds 2 aliases and 1 parent tag.',
    );
    expect(button('Import tags')).toBeDefined();

    // None of its files is here, but its tags are worth importing still.
    await openPreview({
      ...aliasesOnly,
      found: { samePlace: 0, moved: 0, shared: 0 },
      notFound: {
        missing: 0,
        uncompared: 0,
        folder: 5_214,
        ambiguous: 0,
        notMedia: 0,
        notFound: 0,
      },
      definitions: { ...noDefinitions, aliases: 1 },
    });
    expect(text(host.querySelector('.summary'))).toBe(
      'None of these files were found in your library folders. Add the folders that hold them, here or in Library folders, then check again. Importing now only adds 1 alias.',
    );
    expect(labels()).toEqual([
      'Export tags…',
      'Import tags…',
      'Import from TagStudio…',
      'Import from catalogue…',
      'Check again',
      'Cancel',
      'Import tags',
    ]);

    await openPreview(aliasesOnly);
    button('Import tags')?.click();
    await render();
    expect(text(host.querySelector('[role="status"]'))).toBe(
      'Added 2 aliases and 1 parent tag. No file got a new tag.',
    );
  });

  it('offers only Close when the tags a tags export describes are all here', async () => {
    await openPreview({ ...tagsOnlyPreview, definitions: noDefinitions }, tagsOnly);
    expect(text(host.querySelector('.summary'))).toBe(
      'Nothing to add: these tags are already here, with their aliases and parent tags.',
    );
    expect(labels()).toEqual([
      'Export tags…',
      'Import tags…',
      'Import from TagStudio…',
      'Import from catalogue…',
      'Check again',
      'Close',
    ]);
    expect(host.querySelector('app-tag-import-preview h4')).toBeNull();

    await openPreview(
      {
        ...tagsOnlyPreview,
        definitions: { ...noDefinitions, skipped: 1, skippedItems: [definitions.skippedItems[2]!] },
      },
      tagsOnly,
    );
    expect(text(host.querySelector('.summary'))).toBe(
      'Nothing to add: the aliases and parent tags not here yet are left out.',
    );
    expect(labels()).toEqual([
      'Export tags…',
      'Import tags…',
      'Import from TagStudio…',
      'Import from catalogue…',
      'Check again',
      'Close',
    ]);
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
    const none: TagImportResult = {
      ...result,
      assignments: 0,
      files: 0,
      newTags: 0,
      skipped: 0,
      notFound: 0,
    };
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

  it('says which tags, aliases and parent tags the import added', async () => {
    const added = async (
      imported: Partial<TagImportResult>,
      opened: TagImportSource = source,
    ): Promise<string> => {
      worker.respond('applyTagImport', () => ({ ...result, skipped: 0, notFound: 0, ...imported }));
      await openPreview({ ...preview, definitions }, opened);
      button('Import tags')?.click();
      await render();
      return text(host.querySelector('[role="status"]'));
    };

    expect(await added({ definitions: { created: 4, aliases: 2, links: 1, skipped: 5 } })).toBe(
      'Added 3,410 tags to 2,980 files, created 13 new tags, and added 2 aliases and 1 parent tag.',
    );
    expect(
      await added({ newTags: 0, definitions: { created: 0, aliases: 0, links: 3, skipped: 0 } }),
    ).toBe('Added 3,410 tags to 2,980 files, and added 3 parent tags.');
    expect(
      await added({
        assignments: 0,
        files: 0,
        newTags: 0,
        definitions: { created: 1, aliases: 1, links: 0, skipped: 0 },
      }),
    ).toBe('Created 1 new tag, and added 1 alias. No file got a new tag.');
    // Another window imported the same tags meanwhile.
    expect(
      await added(
        {
          assignments: 0,
          files: 0,
          newTags: 0,
          definitions: { created: 0, aliases: 0, links: 0, skipped: 0 },
        },
        tagsOnly,
      ),
    ).toBe('Nothing was added.');
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
      notFound: { missing: 0, uncompared: 0, folder: 1, ambiguous: 0, notMedia: 0, notFound: 0 },
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
  describe('from a classification catalogue', () => {
    const chosen: CatalogueStatus = {
      path: 'D:\\Drama\\media_catalog_5770_updated.csv',
      rows: 5_770,
      invalid: 0,
      problems: [],
      error: null,
    };
    const NONE = { lowConfidence: false, flagged: false, unclear: false };
    const catalogue: TagImportSource = {
      token: 'token-cat',
      kind: 'catalogue',
      name: 'media_catalog_5770_updated.csv',
      exportedAt: '2026-10-18T12:00:00.000Z',
      platform: null,
      files: 5_003,
      tags: 66,
      invalid: 0,
      problems: [],
      tagStudio: null,
      catalogue: {
        filters: NONE,
        rows: 5_770,
        matching: { lowConfidence: 35, flagged: 757, unclear: 34 },
        leftOut: 767,
        renamed: 0,
        formatsWithoutTag: 790,
        filesWithoutFormat: 700,
        formatItems: [
          { name: 'phone video', files: 133 },
          { name: 'subtitles', files: 41 },
        ],
      },
    };
    const cataloguePreview: TagImportPreview = {
      ...restore,
      planId: 9,
      found: { samePlace: 4_990, moved: 10, shared: 0 },
      notFound: { missing: 0, uncompared: 0, folder: 0, ambiguous: 0, notMedia: 0, notFound: 3 },
      folders: [
        {
          exported: 'D:\\Drama\\!Unsorted\\2026-10',
          files: 5_003,
          found: 5_000,
          foundIn: ['D:\\Drama'],
          inLibrary: false,
          suspicious: false,
          addable: false,
        },
      ],
      movedItems: [],
      missedItems: [],
      additions: { assignments: 5_017, files: 5_000, newTags: 0 },
      additionsWithChanged: { assignments: 5_017, files: 5_000, newTags: 0 },
      definitions: { ...noDefinitions, created: 64, links: 45 },
    };

    /** The catalogue chosen in Settings is `shown`. */
    const choose = async (shown: CatalogueStatus | null): Promise<void> => {
      worker.respond('getCatalogue', () => shown);
      worker.emit('catalogueChanged', null);
      await render();
    };
    const checkbox = (label: string): HTMLInputElement | undefined =>
      [...host.querySelectorAll<HTMLLabelElement>('.filters label')]
        .find((each) => text(each) === label)
        ?.querySelector('input') ?? undefined;

    it('offers to import from a catalogue once one is chosen and can be read', async () => {
      const importButton = (): HTMLButtonElement | undefined => button('Import from catalogue…');
      expect(importButton()?.getAttribute('aria-disabled')).toBe('true');
      expect(
        text(host.querySelector(`#${importButton()?.getAttribute('aria-describedby') ?? ''}`)),
      ).toBe(
        'To import from a classification catalogue, choose one under Classification catalogue below.',
      );
      importButton()?.click();
      await render();
      expect(worker.callsTo('openCatalogueImport')).toEqual([]);

      await choose({ ...chosen, rows: 0, error: 'Cannot read the catalogue.' });
      expect(importButton()?.getAttribute('aria-disabled')).toBe('true');

      await choose(chosen);
      expect(importButton()?.getAttribute('aria-disabled')).toBeNull();
      expect(importButton()?.getAttribute('aria-describedby')).toBeNull();
    });

    it('previews a catalogue in its own words, and includes other rows when asked', async () => {
      await choose(chosen);
      worker.respond('openCatalogueImport', (filters) => ({
        ...catalogue,
        catalogue: { ...(catalogue.catalogue as CatalogueImportDetails), filters },
      }));
      worker.respond('planTagImport', () => cataloguePreview);

      button('Import from catalogue…')?.click();
      await render();

      expect(worker.callsTo('openCatalogueImport')).toEqual([[NONE]]);
      expect(worker.callsTo('planTagImport')).toEqual([['token-cat']]);
      const shown = host.querySelector('app-tag-import-preview');
      expect(text(shown?.querySelector('h3'))).toBe(
        'Import tags from the classification catalogue “media_catalog_5770_updated.csv”?',
      );
      expect(text(shown?.querySelector('.about'))).toBe(
        'Last changed on October 18, 2026 · 5,003 classified files · 66 tags',
      );
      expect(text(shown?.querySelector('.filters legend'))).toBe(
        '767 of the 5,770 rows are left out:',
      );
      expect(
        [...(shown?.querySelectorAll('.filters label') ?? [])].map((label) => text(label)),
      ).toEqual([
        'Include the 35 rows of low confidence',
        'Include the 757 rows flagged for further review',
        'Include the 34 rows whose subject is unclear (Needs context or audio review)',
      ]);
      const shownText = text(shown);
      expect(shownText).toContain(
        '10 moved since they were classified, recognised by their name, size and date',
      );
      expect(shownText).toContain('Folder of the catalogue');
      expect(shownText).toContain(
        '790 format tags, on 700 files, are left out: no tag has their name. Make a tag of one, or an alias of a tag, and import again to add it.',
      );
      expect(
        [...(shown?.querySelectorAll('[aria-label="Format tags left out"] li') ?? [])].map((item) =>
          text(item),
        ),
      ).toEqual(['phone video · 133 files', 'subtitles · 41 files', '… and 788 more']);

      const low = checkbox('Include the 35 rows of low confidence');
      if (low) {
        low.checked = true;
        low.dispatchEvent(new Event('change'));
      }
      await render();

      expect(worker.callsTo('openCatalogueImport')).toEqual([
        [NONE],
        [{ ...NONE, lowConfidence: true }],
      ]);
      expect(checkbox('Include the 35 rows of low confidence')?.checked).toBe(true);
    });

    it('says how an import from a catalogue ended, in its own words', async () => {
      await choose(chosen);
      worker.respond('openCatalogueImport', () => catalogue);
      worker.respond('planTagImport', () => cataloguePreview);
      worker.respond('applyTagImport', () => ({
        assignments: 5_017,
        files: 5_000,
        newTags: 0,
        skipped: 2,
        notFound: 3,
        definitions: { created: 64, aliases: 0, links: 45, skipped: 0 },
      }));
      button('Import from catalogue…')?.click();
      await render();

      button('Import tags')?.click();
      await render();

      const outcome = text(host.querySelector('.outcome'));
      expect(outcome).toContain(
        '3 files of the catalogue were not found, or are not images or videos, so their tags were not imported. Import from the catalogue again',
      );
      expect(outcome).toContain('import from the catalogue again to include them.');
      expect(document.activeElement).toBe(button('Import from catalogue…'));
    });
  });

  describe('from TagStudio', () => {
    const library: TagImportSource = {
      token: 'token-ts',
      kind: 'tagStudio',
      name: '/Users/seb/Pictures/Drama',
      exportedAt: '2026-11-15T12:00:00.000Z',
      platform: null,
      files: 2_964,
      tags: 296,
      invalid: 0,
      problems: [],
      catalogue: null,
      tagStudio: {
        version: 102,
        renamed: 1,
        renamedItems: [
          {
            from: 'Diversity, Equity, and Inclusion',
            to: 'Diversity Equity and Inclusion',
            why: 'characters',
          },
        ],
        leftOut: {
          colors: 5,
          icons: 0,
          categories: 0,
          hidden: 0,
          fields: 0,
          builtIn: 3,
          broken: 0,
          otherFolders: 0,
        },
      },
    };
    const libraryPreview: TagImportPreview = {
      ...restore,
      planId: 7,
      found: { samePlace: 2_587, moved: 330, shared: 0 },
      notFound: { missing: 0, uncompared: 0, folder: 0, ambiguous: 6, notMedia: 37, notFound: 4 },
      folders: [
        {
          exported: '/Users/seb/Pictures/Drama',
          files: 2_964,
          found: 2_917,
          foundIn: ['/Users/seb/Pictures/Drama'],
          inLibrary: true,
          suspicious: false,
          addable: false,
        },
      ],
      movedItems: [
        {
          exported: '/Users/seb/Pictures/Drama/Old/a.mp4',
          current: '/Users/seb/Pictures/Drama/New/a.mp4',
        },
      ],
      missedItems: [
        { exported: '/Users/seb/Pictures/Drama/One/b.jpg', reason: 'ambiguous' },
        { exported: '/Users/seb/Pictures/Drama/notes.pdf', reason: 'notMedia' },
      ],
      additions: { assignments: 4_780, files: 2_914, newTags: 0 },
      additionsWithChanged: { assignments: 4_780, files: 2_914, newTags: 0 },
      definitions: { ...noDefinitions, created: 296, aliases: 61, links: 43 },
    };

    const openLibrary = async (): Promise<void> => {
      openTagStudioImport = () => Promise.resolve(library);
      worker.respond('planTagImport', () => libraryPreview);
      button('Import from TagStudio…')?.focus();
      button('Import from TagStudio…')?.click();
      await render();
    };

    it('previews a TagStudio library in its own words', async () => {
      await openLibrary();

      const shown = host.querySelector('app-tag-import-preview');
      expect(worker.callsTo('planTagImport')).toEqual([['token-ts']]);
      expect(text(shown?.querySelector('h3'))).toBe(
        'Import tags from the TagStudio library “/Users/seb/Pictures/Drama”?',
      );
      expect(text(shown?.querySelector('.about'))).toBe(
        'Last changed on November 15, 2026 · 2,964 tagged files · 296 tags',
      );
      const shownText = text(shown);
      expect(shownText).toContain(
        '330 moved since TagStudio last saw them, recognised by their name',
      );
      expect(shownText).toContain(
        '6 are no longer at their place, and several files have their name',
      );
      expect(shownText).toContain('37 are not images or videos, which SG Tag does not index');
      expect(shownText).toContain(
        '/Users/seb/Pictures/Drama/One/b.jpg several files have this name',
      );
      expect(shownText).toContain('/Users/seb/Pictures/Drama/notes.pdf not an image or a video');
      expect(shownText).toContain(
        'Diversity, Equity, and Inclusion → Diversity Equity and Inclusion · a comma, a double quote, a leading = or a control character',
      );
      expect(
        [...(shown?.querySelectorAll('[aria-label="Not carried over"] li') ?? [])].map((item) =>
          text(item),
        ),
      ).toEqual(['The colours of 5 tags', '3 built-in tags of TagStudio not in use, or Meta Tags']);
      expect(text(shown?.querySelector('.summary'))).toBe(
        'Importing adds 4,780 tags to 2,914 files, creates 296 new tags, and adds 61 aliases and 43 parent tags.',
      );
    });

    it('gives the focus back to Import from TagStudio… when the preview is closed', async () => {
      await openLibrary();

      button('Cancel')?.click();
      await render();

      expect(host.querySelector('app-tag-import-preview')).toBeNull();
      expect(document.activeElement).toBe(button('Import from TagStudio…'));
      expect(worker.callsTo('closeTagImport')).toHaveLength(1);
    });

    it('says what was imported, and why some files were not', async () => {
      worker.respond('applyTagImport', () => ({ ...result, skipped: 0, notFound: 47 }));
      await openLibrary();

      button('Import tags')?.click();
      await render();

      expect(worker.callsTo('applyTagImport')).toEqual([['token-ts', 7, true]]);
      expect(text(host.querySelector('.outcome'))).toContain(
        '47 files of the TagStudio library were not found, or are not images or videos, so their tags were not imported. Import from TagStudio again once the files are in your library folders: tags already imported are skipped.',
      );
      expect(document.activeElement).toBe(button('Import from TagStudio…'));
    });

    it('says it is reading the TagStudio library', async () => {
      const opening = Promise.withResolvers<TagImportSource | null>();
      openTagStudioImport = () => opening.promise;
      button('Import from TagStudio…')?.click();
      await render();
      await progress({ step: 'reading', done: 1, total: 4 });

      expect(text(host.querySelector('[role="status"]'))).toBe(
        'Reading the TagStudio library… 25%',
      );
    });
  });
});
