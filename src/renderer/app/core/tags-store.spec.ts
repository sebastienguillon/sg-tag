import { TestBed } from '@angular/core/testing';
import type { Tag } from '@shared/model';
import { FakeWorkerClient, settle } from '../testing/fake-worker-client';
import { TagsStore } from './tags-store';
import { WorkerClient } from './worker-client';

const tag = (id: number, path: string, fileCount: number): Tag => ({
  id,
  path,
  name: path.split('/').at(-1) ?? path,
  parentId: null,
  fileCount,
});

describe('TagsStore.suggest', () => {
  it('ranks path prefixes, then segment prefixes, then substrings; most used first', async () => {
    const worker = new FakeWorkerClient();
    worker.respond('listTags', () => [
      tag(1, 'Trips/Japan', 3),
      tag(2, 'japan', 1),
      tag(3, 'food/japanese', 9),
      tag(4, 'ninja', 5),
      tag(5, 'jazz', 2),
    ]);
    TestBed.configureTestingModule({ providers: [{ provide: WorkerClient, useValue: worker }] });
    const store = TestBed.inject(TagsStore);
    TestBed.tick();
    await settle();

    expect(store.suggest('ja').map((t) => t.path)).toEqual([
      'jazz',
      'japan',
      'food/japanese',
      'Trips/Japan',
      'ninja',
    ]);
    expect(store.suggest('JA', new Set(['jazz'])).map((t) => t.path)[0]).toBe('japan');
    expect(store.suggest('  ')).toEqual([]);
  });
});
