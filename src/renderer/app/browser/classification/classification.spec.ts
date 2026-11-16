import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { CatalogueEntry } from '@shared/model';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, settle } from '../../testing/fake-worker-client';
import { Classification } from './classification';

const entry: CatalogueEntry = {
  category: 'Animals',
  subcategory: 'Wildlife pets and animal interactions',
  confidence: 'high',
  flagged: false,
  reviewReasons: [],
  reviewStatus: null,
  topic: 'A cat on a sofa',
  visibleContent: 'A grey cat.',
  reviewNotes: null,
  found: 'samePlace',
  classifiedPath: '/library/cat.jpg',
  suggestions: [
    { name: 'Wildlife pets and animal interactions', kind: 'subject', added: false },
    { name: 'phone video', kind: 'format', added: true },
    { name: 'selfie', kind: 'format', added: false },
  ],
};

describe('Classification', () => {
  let fixture: ComponentFixture<Classification>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  const mount = async (shown: CatalogueEntry | null, fileId = 1): Promise<void> => {
    worker.respond('getCatalogueEntry', () => shown);
    fixture = TestBed.createComponent(Classification);
    fixture.componentRef.setInput('fileId', fileId);
    host = fixture.nativeElement as HTMLElement;
    await render();
  };
  const text = (selector: string): string =>
    host.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const suggestion = (name: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('.suggestion')].find(
      (button) => button.textContent.replace('(added)', '').trim() === name,
    );
  const addAll = (): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('.actions .button')].find((button) =>
      button.textContent.includes('Add all'),
    );

  beforeEach(() => {
    worker = new FakeWorkerClient();
    TestBed.configureTestingModule({ providers: [{ provide: WorkerClient, useValue: worker }] });
  });

  it('shows nothing for a file the catalogue does not list', async () => {
    await mount(null);
    expect(host.querySelector('section')).toBeNull();
  });

  it('shows what the catalogue says of the file, and the tags it suggests', async () => {
    await mount(entry);

    expect(text('h3')).toBe('Classification');
    expect(text('.subject')).toBe('Animals › Wildlife pets and animal interactions');
    expect(
      [...host.querySelectorAll('.meta dt, .meta dd')].map((item) => item.textContent.trim()),
    ).toEqual(['Confidence', 'high', 'Topic', 'A cat on a sofa', 'Visible content', 'A grey cat.']);
    expect(host.querySelector('.notice')).toBeNull();
    expect(
      [...host.querySelectorAll('.suggestions li')].map((item) =>
        item.textContent.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual([
      'Wildlife pets and animal interactions in Animals',
      'phone video (added)',
      'selfie',
    ]);
    expect(suggestion('phone video')?.getAttribute('aria-disabled')).toBe('true');
    expect(suggestion('selfie')?.getAttribute('aria-disabled')).toBeNull();
  });

  it('says when the file changed or moved since it was classified, and when it is flagged', async () => {
    await mount({ ...entry, found: 'changed', flagged: true, reviewStatus: 'Unresolved subject' });
    expect(
      [...host.querySelectorAll('.notice')].map((notice) => notice.textContent.trim()),
    ).toEqual([
      'This file changed since it was classified: what the catalogue says may no longer hold.',
      'Flagged for further review: Unresolved subject',
    ]);

    await mount({ ...entry, found: 'moved', classifiedPath: '/library/Unsorted/cat.jpg' });
    expect(text('.notice')).toBe('Classified at /library/Unsorted/cat.jpg');
  });

  it('lists why the file needs further review, when the catalogue says', async () => {
    await mount({
      ...entry,
      flagged: true,
      reviewReasons: ['place not stated', 'tail frame failed'],
    });

    expect(text('.notice p')).toBe('Flagged for further review');
    expect([...host.querySelectorAll('.notice li')].map((item) => item.textContent)).toEqual([
      'place not stated',
      'tail frame failed',
    ]);
  });

  it('adds a suggested tag, or all those the file lacks, and none it has', async () => {
    worker.respond('addCatalogueTags', () => []);
    await mount(entry, 7);

    suggestion('selfie')?.click();
    suggestion('phone video')?.click();
    addAll()?.click();
    await render();

    expect(worker.callsTo('addCatalogueTags')).toEqual([
      [7, ['selfie']],
      [7, ['Wildlife pets and animal interactions', 'selfie']],
    ]);
  });

  it('reads the entry again when tags or the catalogue change, keeping the one shown meanwhile', async () => {
    await mount(entry);
    const added = {
      ...entry,
      suggestions: entry.suggestions.map((each) => ({ ...each, added: true })),
    };
    const reading = Promise.withResolvers<CatalogueEntry>();
    worker.respond('getCatalogueEntry', () => reading.promise);

    worker.emit('tagsChanged', null);
    await settle();
    fixture.detectChanges();
    expect(text('.subject')).toBe('Animals › Wildlife pets and animal interactions');

    reading.resolve(added);
    await render();
    expect(addAll()?.getAttribute('aria-disabled')).toBe('true');

    worker.respond('getCatalogueEntry', () => null);
    worker.emit('catalogueChanged', null);
    await render();
    expect(host.querySelector('section')).toBeNull();
  });

  it('says why tags could not be added', async () => {
    worker.respond('addCatalogueTags', () =>
      Promise.reject(
        new Error('Tags are being exported or imported: add these once that is done.'),
      ),
    );
    await mount(entry);

    suggestion('selfie')?.click();
    await render();

    expect(text('[role="alert"]')).toBe(
      'The tags could not be added: Tags are being exported or imported: add these once that is done.',
    );
  });
});
