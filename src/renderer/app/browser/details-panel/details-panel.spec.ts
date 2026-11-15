import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { DesktopBridge } from '@shared/desktop-api';
import type { FileCopy, FileDetails, Tag, TagAddOutcome } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { LibraryStore } from '../../core/library-store';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../../testing/fake-worker-client';
import { DetailsPanel } from './details-panel';

const copy: FileCopy = {
  id: 2,
  name: 'beach copy.jpg',
  path: '/library/backup/beach copy.jpg',
  offline: false,
  tags: [],
};
const backup: FileCopy = {
  id: 3,
  name: 'beach.jpg',
  path: '/backup/beach.jpg',
  offline: false,
  tags: [],
};
const photo: FileDetails = {
  id: 1,
  name: 'beach.jpg',
  kind: 'image',
  format: 'JPG',
  size: 2_000_000,
  mtimeMs: 42,
  width: null,
  height: null,
  durationMs: null,
  offline: false,
  path: '/library/beach.jpg',
  folder: '',
  rootPath: '/library',
  birthtimeMs: null,
  codec: null,
  missing: false,
  tags: [{ id: 10, name: 'Japan' }],
  copies: [copy],
};

const tag = (id: number, name: string, fileCount: number): Tag => ({
  id,
  name,
  aliases: [],
  parentIds: [],
  fileCount,
});

describe('DetailsPanel', () => {
  let fixture: ComponentFixture<DetailsPanel>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  let trashed: number[];
  let trashFile: DesktopBridge['trashFile'];

  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((candidate) => candidate.textContent.includes(label));
  const trashButton = (path: string): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>(`[aria-label="Move ${path} to Trash"]`);
  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  /** Shows other details for the selected file, as after a change in the worker. */
  const reload = async (details: FileDetails): Promise<void> => {
    worker.respond('getDetails', () => details);
    worker.emit('tagsChanged', null);
    await render();
  };
  const chip = (name: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('.chip-label')].find(
      (candidate) => candidate.firstChild?.textContent?.trim() === name,
    );
  /** Types `name` in the tag input, or pastes it, and presses Enter. */
  const addTag = async (name: string): Promise<void> => {
    const field = host.querySelector<HTMLInputElement>('app-tag-input input')!;
    field.value = name;
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await render();
  };
  /** What the panel says of a name the worker made no tag of: its own line, under the tag input. */
  const refusal = (): string | null =>
    host.querySelector('.tags > [role="alert"]')?.textContent ?? null;
  /** Holds the next move to the Trash, as during the round trip to the main process. */
  const holdTrash = (): PromiseWithResolvers<undefined> => {
    const move = Promise.withResolvers<undefined>();
    trashFile = () => move.promise;
    return move;
  };
  /** Asks to move a file to the Trash with `trash`, and confirms. */
  const moveToTrash = async (trash: HTMLButtonElement | null | undefined): Promise<void> => {
    trash?.click();
    await render();
    button('Move to Trash')?.click();
    await render();
  };

  beforeEach(async () => {
    worker = new FakeWorkerClient();
    // Pending resources would keep the fixture from ever being stable.
    worker.respond('search', () => ({ ids: Int32Array.from([photo.id]), elapsedMs: 0 }));
    worker.respond('listTags', () => []);
    worker.respond('getDetails', () => photo);
    trashed = [];
    trashFile = (id) => {
      trashed.push(id);
      return Promise.resolve();
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkerClient, useValue: worker },
        {
          provide: DESKTOP,
          useValue: { ...fakeDesktop, trashFile: (id: number) => trashFile(id) },
        },
      ],
    });
    TestBed.inject(LibraryStore).selection.set(new Set([photo.id]));
    fixture = TestBed.createComponent(DetailsPanel);
    host = fixture.nativeElement as HTMLElement;
    await render();
  });

  it('shows each tag of the file by its name, on a chip that searches for it', async () => {
    await reload({
      ...photo,
      tags: [
        { id: 10, name: 'Japan' },
        { id: 12, name: 'New York' },
      ],
    });
    expect(
      [...host.querySelectorAll('.chip-label')].map((label) => label.textContent.trim()),
    ).toEqual(['Japan', 'New York']);
    expect(chip('Japan')?.title).toBe('Search tag:Japan');
    expect(chip('New York')?.title).toBe('Search tag:"New York"');

    const store = TestBed.inject(LibraryStore);
    chip('Japan')?.click();
    expect(store.query()).toBe('tag:Japan');
    // Quoted, or the search would read two terms.
    chip('New York')?.click();
    expect(store.query()).toBe('tag:"New York"');
  });

  it('takes a tag from the file with the button of its chip', async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="Remove tag Japan"]')?.click();
    await render();
    expect(worker.callsTo('removeTags')).toEqual([[[photo.id], [10]]]);
  });

  it('gives the file the tag typed, by its name', async () => {
    worker.respond('addTags', (_ids, names) =>
      names.map((name) => ({ name, status: 'added', tag: { id: 11, name } })),
    );
    await addTag('Kyoto');
    expect(worker.callsTo('addTags')).toEqual([[[photo.id], ['Kyoto']]]);
    expect(refusal()).toBeNull();
  });

  it('leaves a name that cannot be a tag to the tag input, which says why: nothing is sent', async () => {
    await addTag('Paris, France');
    expect(worker.callsTo('addTags')).toEqual([]);
    expect(host.querySelector('app-tag-input [role="alert"]')?.textContent).toBe(
      'A tag cannot contain a comma: commas separate tags.',
    );
    expect(refusal()).toBeNull();
  });

  // The worker has the last word on the names that the tag input lets through. In the tests below
  // it refuses such names, as a worker with a stricter rule would, and the reason it gives is only
  // there to be shown: the field is empty by then, so the panel names the text that was not added.

  it('says why the worker made no tag of a name, until another one is sent', async () => {
    worker.respond('addTags', (_ids, names) =>
      names.map((name) => ({ name, status: 'refused', problem: 'comma' })),
    );
    await addTag('Kyoto');
    expect(worker.callsTo('addTags')).toEqual([[[photo.id], ['Kyoto']]]);
    expect(refusal()).toBe(
      '“Kyoto” was not added. A tag cannot contain a comma: commas separate tags.',
    );
    expect(host.querySelector('app-tag-input [role="alert"]')).toBeNull();

    // Gone as soon as the next name is on its way, whatever becomes of it.
    const answer = Promise.withResolvers<readonly TagAddOutcome[]>();
    worker.respond('addTags', () => answer.promise);
    await addTag('Osaka');
    expect(refusal()).toBeNull();

    answer.resolve([{ name: 'Osaka', status: 'refused', problem: 'equals' }]);
    await render();
    expect(refusal()).toBe('“Osaka” was not added. A tag cannot start with “=”.');
  });

  it('quotes only the start of a long name that the worker made no tag of', async () => {
    worker.respond('addTags', (_ids, names) =>
      names.map((name) => ({ name, status: 'refused', problem: 'tooLong' })),
    );
    await addTag(`${'pine'.repeat(15)}apple${'s'.repeat(900)}`);
    expect(refusal()).toBe(
      `“${'pine'.repeat(15)}…” was not added. A tag cannot be longer than 1,024 characters.`,
    );

    // Cut before a character that takes two UTF-16 units, not through it.
    await addTag(`${'z'.repeat(59)}\u{1F600}${'s'.repeat(900)}`);
    expect(refusal()).toBe(
      `“${'z'.repeat(59)}…” was not added. A tag cannot be longer than 1,024 characters.`,
    );
  });

  it('forgets a name that made no tag once other files are selected', async () => {
    const other: FileDetails = { ...photo, id: 4, name: 'dunes.jpg', copies: [] };
    worker.respond('getDetails', (id) => (id === other.id ? other : photo));
    worker.respond('addTags', (_ids, names) =>
      names.map((name) => ({ name, status: 'refused', problem: 'quote' })),
    );
    await addTag('Kyoto');
    expect(refusal()).toBe('“Kyoto” was not added. A tag cannot contain a double quote.');

    TestBed.inject(LibraryStore).selection.set(new Set([other.id]));
    await render();
    expect(host.querySelector('.title')?.textContent).toBe('dunes.jpg');
    expect(refusal()).toBeNull();
  });

  it('does not say of other files that a name made no tag', async () => {
    const other: FileDetails = { ...photo, id: 4, name: 'dunes.jpg', copies: [] };
    worker.respond('getDetails', (id) => (id === other.id ? other : photo));
    const answer = Promise.withResolvers<readonly TagAddOutcome[]>();
    worker.respond('addTags', () => answer.promise);
    await addTag('Kyoto');
    TestBed.inject(LibraryStore).selection.set(new Set([other.id]));
    await render();

    answer.resolve([{ name: 'Kyoto', status: 'refused', problem: 'comma' }]);
    await render();
    expect(host.querySelector('.title')?.textContent).toBe('dunes.jpg');
    expect(refusal()).toBeNull();
  });

  it('shows how many of the selected files have each tag, and suggests those some lack', async () => {
    worker.respond('getSelectionTags', () => [
      { id: 10, name: 'Japan', fileCount: 2 },
      { id: 11, name: 'Kansai', fileCount: 1 },
    ]);
    worker.respond('listTags', () => [
      tag(10, 'Japan', 8),
      tag(11, 'Kansai', 3),
      tag(12, 'Osaka', 1),
    ]);
    worker.emit('tagsChanged', null);
    TestBed.inject(LibraryStore).selection.set(new Set([photo.id, 4]));
    await render();
    expect(host.querySelector('.title')?.textContent).toBe('2 files selected');
    expect(worker.callsTo('getSelectionTags').at(-1)).toEqual([[photo.id, 4]]);
    expect(chip('Japan')?.querySelector('.chip-count')).toBeNull();
    expect(chip('Kansai')?.querySelector('.chip-count')?.textContent).toBe('1/2');

    // Japan is on both files already; Kansai can still be given to the other one.
    const field = host.querySelector<HTMLInputElement>('app-tag-input input')!;
    field.focus();
    field.value = 'a';
    field.dispatchEvent(new Event('input'));
    await render();
    expect(
      [...host.querySelectorAll('app-tag-input [role="option"] .name')].map(
        (name) => name.textContent,
      ),
    ).toEqual(['Kansai', 'Osaka']);
  });

  it('lists identical copies with their location and tags', async () => {
    const copies = host.querySelector('.copies');
    expect(copies?.querySelector('h3')?.textContent).toBe('Identical copy');
    expect(copies?.querySelector('.copy-path')?.textContent).toBe('/library/backup/beach copy.jpg');
    expect(copies?.querySelector('.copy-tags')?.textContent.trim()).toBe('No tags');

    await reload({
      ...photo,
      copies: [
        {
          ...copy,
          tags: [
            { id: 10, name: 'Japan' },
            { id: 12, name: 'New York' },
          ],
        },
      ],
    });
    expect(host.querySelector('.copy-tags')?.textContent.trim()).toBe('Japan, New York');
  });

  it('gives all copies the same tags on request', async () => {
    button('Give all copies the same tags')?.click();
    await render();
    expect(worker.callsTo('shareTagsWithCopies')).toEqual([[photo.id]]);
  });

  it('moves a copy to the Trash once confirmed', async () => {
    host.querySelector<HTMLButtonElement>('[aria-label^="Move /library/backup"]')?.click();
    await render();
    expect(host.querySelector('.confirm')?.textContent).toContain(
      'Move “beach copy.jpg” to Trash?',
    );
    expect(trashed).toEqual([]);

    button('Move to Trash')?.click();
    await render();
    expect(trashed).toEqual([2]);
    expect(host.querySelector('.confirm')).toBeNull();
    expect(document.activeElement).toBe(host);
  });

  it('leaves the focus where the user put it during the move', async () => {
    const move = holdTrash();
    await moveToTrash(trashButton(copy.path));
    const search = document.createElement('input');
    document.body.append(search);
    onTestFinished(() => {
      search.remove();
    });
    search.focus();

    move.resolve(undefined);
    await render();
    expect(trashButton(copy.path)).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('leaves another file selected during the move alone', async () => {
    const other: FileDetails = { ...photo, id: 4, name: 'dunes.jpg', copies: [backup] };
    worker.respond('getDetails', (id) => (id === other.id ? other : photo));
    const move = holdTrash();
    await moveToTrash(trashButton(copy.path));
    TestBed.inject(LibraryStore).selection.set(new Set([other.id]));
    await render();

    move.resolve(undefined);
    await render();
    expect(host.querySelector('.title')?.textContent).toBe('dunes.jpg');
    expect(host.contains(document.activeElement)).toBe(false);
  });

  it('does not report a failure once another file is selected', async () => {
    const other: FileDetails = { ...photo, id: 4, name: 'dunes.jpg', copies: [backup] };
    worker.respond('getDetails', (id) => (id === other.id ? other : photo));
    const move = holdTrash();
    await moveToTrash(trashButton(copy.path));
    TestBed.inject(LibraryStore).selection.set(new Set([other.id]));
    await render();

    move.reject(new Error('No identical copy.'));
    await render();
    expect(host.querySelector('.copies')).not.toBeNull();
    expect(host.querySelector('.error')).toBeNull();
  });

  it('keeps the confirmation while the move is under way', async () => {
    const move = holdTrash();
    await moveToTrash(trashButton(copy.path));
    expect(button('Cancel')?.disabled).toBe(true);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    host.querySelector('.confirm')?.dispatchEvent(escape);
    await render();
    expect(escape.defaultPrevented).toBe(true);
    expect(host.querySelector('.confirm')).not.toBeNull();

    move.resolve(undefined);
    await render();
    expect(host.querySelector('.confirm')).toBeNull();
  });

  it('describes the confirmation with its question', async () => {
    trashButton(copy.path)?.click();
    await render();
    const id = host.querySelector('[role="alertdialog"]')?.getAttribute('aria-describedby');
    expect(document.getElementById(id ?? '')?.textContent).toContain(
      'Move “beach copy.jpg” to Trash?',
    );
  });

  it('stops listing and counting a moved copy before the index catches up', async () => {
    await reload({ ...photo, copies: [copy, backup] });
    await moveToTrash(trashButton(copy.path));
    expect(trashed).toEqual([copy.id]);
    expect(trashButton(copy.path)).toBeNull();
    expect(host.querySelector('.copies h3')?.textContent).toBe('Identical copy');

    // The tags given to the copies come first: the index still has the moved one.
    await reload({ ...photo, copies: [copy, backup] });
    expect(trashButton(copy.path)).toBeNull();
    button('Move this one to Trash')?.click();
    await render();
    expect(host.querySelector('.confirm')?.textContent).toContain(
      'Its tags are first given to the copy that stays.',
    );
  });

  it('lists a moved copy again if it comes back once the index caught up', async () => {
    await moveToTrash(trashButton(copy.path));
    expect(host.querySelector('.copies')).toBeNull();
    await reload({ ...photo, copies: [] });

    // Put back from the Trash.
    await reload(photo);
    expect(trashButton(copy.path)).not.toBeNull();
  });

  it('offers nothing more to do with the selected file once in the Trash', async () => {
    await moveToTrash(button('Move this one to Trash'));
    expect(trashed).toEqual([photo.id]);
    expect(host.querySelector('.notice')?.textContent).toContain('Moved to Trash.');
    expect(button('Open')).toBeUndefined();
    expect(button('Show in Finder')).toBeUndefined();
    expect(host.querySelector('.chip-remove')).toBeNull();
    expect(host.querySelector('app-tag-input')).toBeNull();
    // Its copy is still on disk.
    expect(host.querySelector('.copy-path')?.textContent).toBe(copy.path);
    expect(trashButton(copy.path)).toBeNull();
    expect(button('Move this one to Trash')).toBeUndefined();
    expect(document.activeElement).toBe(host);
  });

  it('stops listing a copy once it is moved to the Trash or changed', async () => {
    worker.respond('getDetails', () => ({ ...photo, copies: [] }));
    worker.emit('filesChanged', { ids: [99] });
    await render();
    expect(host.querySelector('.copies')).not.toBeNull();

    worker.emit('filesChanged', { ids: [2] });
    await render();
    expect(host.querySelector('.copies')).toBeNull();
  });

  it('keeps the files in place when no other copy is on a connected drive', async () => {
    await reload({ ...photo, copies: [{ ...copy, offline: true }] });
    expect(button('Move this one to Trash')?.disabled).toBe(true);
    expect(button('Move this one to Trash')?.title).toBe(
      'The other copy is on a drive that is not connected',
    );

    await reload({
      ...photo,
      offline: true,
      copies: [copy, { ...backup, offline: true }],
    });
    const copyTrash = trashButton('/library/backup/beach copy.jpg');
    expect(copyTrash?.disabled).toBe(true);
    expect(copyTrash?.title).toBe('The other copies are on drives that are not connected');
  });

  it('drops the confirmation for good when the file can no longer go', async () => {
    button('Move this one to Trash')?.click();
    await render();
    await reload({ ...photo, copies: [{ ...copy, offline: true }] });
    expect(host.querySelector('.confirm')).toBeNull();

    // The drive is connected again.
    await reload(photo);
    expect(host.querySelector('.confirm')).toBeNull();
  });

  it('says that only the copies on a connected drive receive the tags', async () => {
    await reload({ ...photo, copies: [copy, { ...backup, offline: true }] });
    button('Move this one to Trash')?.click();
    await render();
    expect(host.querySelector('.confirm')?.textContent).toContain(
      'Its tags are first given to the copy on a connected drive.',
    );
  });

  it('puts the focus on Cancel, and gives it back to the trash button on Escape', async () => {
    const copyTrash = trashButton('/library/backup/beach copy.jpg');
    copyTrash?.focus();
    copyTrash?.click();
    await render();
    expect(document.activeElement).toBe(button('Cancel'));

    let escapes = 0;
    const countEscape = (): void => {
      escapes++;
    };
    document.addEventListener('keydown', countEscape);
    button('Cancel')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    document.removeEventListener('keydown', countEscape);
    await render();
    expect(host.querySelector('.confirm')).toBeNull();
    expect(escapes).toBe(0);
    expect(document.activeElement).toBe(copyTrash);
    expect(trashed).toEqual([]);
  });

  it('gives the focus back to the trash button on Cancel', async () => {
    const fileTrash = button('Move this one to Trash');
    fileTrash?.click();
    await render();
    button('Cancel')?.click();
    await render();
    expect(host.querySelector('.confirm')).toBeNull();
    expect(document.activeElement).toBe(fileTrash);
  });

  it('explains why a file was not moved to the Trash', async () => {
    trashFile = () =>
      Promise.reject(
        new Error("Error invoking remote method 'shell:trash-file': Error: No identical copy."),
      );
    button('Move this one to Trash')?.click();
    await render();
    button('Move to Trash')?.click();
    await render();
    expect(host.querySelector('.error')?.textContent).toBe('No identical copy.');
    expect(document.activeElement).toBe(button('Cancel'));
  });
});
