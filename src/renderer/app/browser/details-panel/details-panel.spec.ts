import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { DesktopBridge } from '@shared/desktop-api';
import type { FileDetails } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { LibraryStore } from '../../core/library-store';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../../testing/fake-worker-client';
import { DetailsPanel } from './details-panel';

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
  tags: [{ id: 10, path: 'trips/japan' }],
  copies: [
    {
      id: 2,
      name: 'beach copy.jpg',
      path: '/library/backup/beach copy.jpg',
      offline: false,
      tags: [],
    },
  ],
};

describe('DetailsPanel', () => {
  let fixture: ComponentFixture<DetailsPanel>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  let trashed: number[];
  let trashFile: DesktopBridge['trashFile'];

  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((candidate) => candidate.textContent.includes(label));
  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
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

  it('lists identical copies with their location and tags', () => {
    const copies = host.querySelector('.copies');
    expect(copies?.querySelector('h3')?.textContent).toBe('Identical copy');
    expect(copies?.querySelector('.copy-path')?.textContent).toBe('/library/backup/beach copy.jpg');
    expect(copies?.querySelector('.copy-tags')?.textContent.trim()).toBe('No tags');
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
  });
});
