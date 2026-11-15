import { TestBed } from '@angular/core/testing';
import type { DesktopBridge } from '@shared/desktop-api';
import type { FileSummary, SearchRequest, SearchResult } from '@shared/model';
import { FakeWorkerClient, fakeDesktop, settle } from '../testing/fake-worker-client';
import { DESKTOP } from './desktop';
import { LibraryStore } from './library-store';
import { WorkerClient } from './worker-client';

function summary(id: number, name = `file-${id}.jpg`): FileSummary {
  return {
    id,
    name,
    kind: 'image',
    format: 'JPG',
    size: 1_000,
    mtimeMs: 1,
    width: null,
    height: null,
    durationMs: null,
    offline: false,
  };
}

function setup(desktop: DesktopBridge = fakeDesktop): {
  store: LibraryStore;
  worker: FakeWorkerClient;
} {
  const worker = new FakeWorkerClient();
  TestBed.configureTestingModule({
    providers: [
      { provide: WorkerClient, useValue: worker },
      { provide: DESKTOP, useValue: desktop },
    ],
  });
  return { store: TestBed.inject(LibraryStore), worker };
}

const result = (...ids: number[]): SearchResult => ({ ids: Int32Array.from(ids), elapsedMs: 1 });

describe('LibraryStore', () => {
  it('keeps one search in flight and skips results that are already stale', async () => {
    const { store, worker } = setup();
    const pending: { request: SearchRequest; resolve: (result: SearchResult) => void }[] = [];
    worker.respond(
      'search',
      (request) => new Promise((resolve) => pending.push({ request, resolve })),
    );

    TestBed.tick();
    expect(pending.map((call) => call.request.query)).toEqual(['']);

    store.query.set('b');
    TestBed.tick();
    store.query.set('be');
    TestBed.tick();
    store.query.set('bea');
    TestBed.tick();
    expect(pending).toHaveLength(1);

    pending[0]?.resolve(result(1, 2, 3));
    await settle();
    // The result for '' arrived while 'bea' was waiting: it is never shown.
    expect(Array.from(store.ids())).toEqual([]);
    expect(pending.map((call) => call.request.query)).toEqual(['', 'bea']);

    pending[1]?.resolve(result(2));
    await settle();
    expect(Array.from(store.ids())).toEqual([2]);
  });

  it('selects single items, toggles, ranges from the anchor, and prunes on new results', async () => {
    const { store, worker } = setup();
    let ids = [10, 11, 12, 13, 14];
    worker.respond('search', () => result(...ids));
    TestBed.tick();
    await settle();

    store.select(1, 'replace');
    store.select(3, 'range');
    expect([...store.selection()]).toEqual([11, 12, 13]);
    store.select(4, 'toggle');
    store.select(2, 'toggle');
    expect([...store.selection()].sort((a, b) => a - b)).toEqual([11, 13, 14]);

    ids = [13, 99];
    store.query.set('x');
    TestBed.tick();
    await settle();
    expect([...store.selection()]).toEqual([13]);
  });

  it('searches again when tags are renamed or linked, if the query compares names of tags', async () => {
    const { store, worker } = setup();
    let ids = [1, 2];
    worker.respond('search', () => result(...ids));
    TestBed.tick();
    await settle();
    store.select(0, 'replace');
    const queries = (): unknown[] =>
      worker.callsTo('search').map(([request]) => (request as SearchRequest).query);
    const changeTags = async (query: string): Promise<void> => {
      store.query.set(query);
      TestBed.tick();
      await settle();
      worker.emit('tagDefinitionsChanged', null);
      await settle();
    };

    // France was added above Paris: the files tagged Paris are found by `tag:France` now.
    ids = [1, 2, 3];
    await changeTags('tag:France');
    expect(queries()).toEqual(['', 'tag:France', 'tag:France']);
    expect(Array.from(store.ids())).toEqual([1, 2, 3]);
    expect([...store.selection()]).toEqual([1]);
    await changeTags('-beach type:image');
    expect(queries().slice(3)).toEqual(['-beach type:image', '-beach type:image']);

    // Nothing these compare depends on the names of tags.
    await changeTags('is:untagged');
    await changeTags('IS:Untagged type:video size:>10mb in:"/Volumes/My Photos"');
    await changeTags('');
    expect(queries().slice(5)).toEqual([
      'is:untagged',
      'IS:Untagged type:video size:>10mb in:"/Volumes/My Photos"',
      '',
    ]);
    expect([...store.selection()]).toEqual([1]);
  });

  it('fetches missing summaries once and refreshes stale ones without dropping them', async () => {
    const { store, worker } = setup();
    let name = 'before.jpg';
    worker.respond('getFiles', (ids) => ids.map((id) => summary(id, name)));

    store.ensureLoaded([1, 2]);
    store.ensureLoaded([1, 2]);
    await settle();
    expect(worker.callsTo('getFiles')).toEqual([[[1, 2]]]);
    expect(store.summary(1)?.name).toBe('before.jpg');

    name = 'after.jpg';
    worker.emit('mediaChanged', { ids: [1] });
    expect(store.summary(1)?.name).toBe('before.jpg');
    store.ensureLoaded([1, 2]);
    await settle();
    expect(worker.callsTo('getFiles').at(-1)).toEqual([[1]]);
    expect(store.summary(1)?.name).toBe('after.jpg');
  });

  it('says why a file was not moved to the Trash, without the channel name', async () => {
    const { store } = setup({
      ...fakeDesktop,
      trashFile: () =>
        Promise.reject(
          new Error("Error invoking remote method 'shell:trash-file': Error: No identical copy."),
        ),
    });
    await expect(store.trash(1)).rejects.toThrow(/^No identical copy\.$/);
  });
});
