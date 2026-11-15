import { TestBed } from '@angular/core/testing';
import { DESKTOP } from '../../core/desktop';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../../testing/fake-worker-client';
import { SearchBar } from './search-bar';

describe('SearchBar', () => {
  it('explains how tags are searched: below, by alias, itself only, and look-alike names', async () => {
    const worker = new FakeWorkerClient();
    worker.respond('search', () => ({ ids: new Int32Array(0), elapsedMs: 0 }));
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkerClient, useValue: worker },
        { provide: DESKTOP, useValue: fakeDesktop },
      ],
    });
    const fixture = TestBed.createComponent(SearchBar);
    await settle();
    await fixture.whenStable();
    const help = fixture.nativeElement as HTMLElement;
    const entries = new Map(
      [...help.querySelectorAll('#search-help dt')].map((term) => [
        term.textContent.trim(),
        term.nextElementSibling?.textContent.replace(/\s+/g, ' ').trim(),
      ]),
    );

    expect(entries.get('beach')).toBe(
      'names, folders or tags containing “beach” (a tag by its name or an alias, with the tags below it)',
    );
    expect(entries.get('tag:France')).toBe(
      'tagged France or a tag below it, by its name or an alias; ignores case and accents',
    );
    expect(entries.get('tag:=France')).toBe('tagged France itself only');
    expect(entries.get('tag:"Paris (Texas)"')).toBe(
      'quoted when it holds spaces; two tags cannot share a name, so tell look-alikes apart this way',
    );
  });
});
