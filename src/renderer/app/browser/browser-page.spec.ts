import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { IndexStatus } from '@shared/model';
import { DESKTOP } from '../core/desktop';
import { WorkerClient } from '../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../testing/fake-worker-client';
import { BrowserPage } from './browser-page';

const status: IndexStatus = {
  totalFiles: 0,
  scanning: null,
  pendingThumbnails: 0,
  offlineRoots: 0,
  duplicateCheck: null,
  tagTransfer: null,
  removingFolders: 0,
};

describe('BrowserPage', () => {
  let fixture: ComponentFixture<BrowserPage>;
  let host: HTMLElement;

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  const press = async (init: KeyboardEventInit): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(event);
    await render();
    return event;
  };

  beforeEach(async () => {
    const worker = new FakeWorkerClient();
    // A library without folders: nothing else to wait for.
    worker.respond('search', () => ({ ids: new Int32Array(0), elapsedMs: 0 }));
    worker.respond('listRoots', () => []);
    worker.respond('listTags', () => []);
    worker.respond('getStatus', () => status);
    worker.respond('getLastTagExport', () => null);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: WorkerClient, useValue: worker },
        { provide: DESKTOP, useValue: fakeDesktop },
      ],
    });
    fixture = TestBed.createComponent(BrowserPage);
    host = fixture.nativeElement as HTMLElement;
    await render();
  });

  it('links to the tags page from the toolbar, next to Settings', () => {
    const link = host.querySelector<HTMLAnchorElement>('.toolbar a[aria-label="Tags"]');
    expect(link?.getAttribute('href')).toBe('/tags');
    expect(link?.title).toBe('Tags');
    expect(link?.querySelector('use')?.getAttribute('href')).toBe('#icon-tag');
    expect(link?.nextElementSibling?.getAttribute('aria-label')).toBe('Settings');
  });

  it('focuses the search field on ⌘-F, and leaves ⌘-comma to the app', async () => {
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search files"]');
    await press({ key: 'f', metaKey: true });
    expect(document.activeElement).toBe(search);

    const settings = await press({ key: ',', metaKey: true });
    expect(settings.defaultPrevented).toBe(false);
  });
});
