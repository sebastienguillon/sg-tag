import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { CatalogueStatus } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { WorkerClient } from '../../core/worker-client';
import { FakeWorkerClient, fakeDesktop, settle } from '../../testing/fake-worker-client';
import { CatalogueSettings } from './catalogue-settings';

const status: CatalogueStatus = {
  path: 'D:\\Drama\\media_catalog_5770_updated.csv',
  rows: 5_770,
  invalid: 0,
  problems: [],
  error: null,
};

describe('CatalogueSettings', () => {
  let fixture: ComponentFixture<CatalogueSettings>;
  let host: HTMLElement;
  let worker: FakeWorkerClient;
  let choose: () => Promise<CatalogueStatus | null>;

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  const mount = async (shown: CatalogueStatus | null): Promise<void> => {
    worker.respond('getCatalogue', () => shown);
    fixture = TestBed.createComponent(CatalogueSettings);
    host = fixture.nativeElement as HTMLElement;
    await render();
  };
  const text = (selector: string): string =>
    host.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent.trim() === label,
    );

  beforeEach(() => {
    worker = new FakeWorkerClient();
    choose = () => Promise.resolve(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkerClient, useValue: worker },
        { provide: DESKTOP, useValue: { ...fakeDesktop, chooseCatalogue: () => choose() } },
      ],
    });
  });

  it('offers to choose a catalogue when none is chosen', async () => {
    await mount(null);
    expect(host.querySelector('dd code')).toBeNull();
    expect(button('Choose catalogue…')).toBeDefined();
    expect(button('Stop using it')).toBeUndefined();
  });

  it('shows the catalogue chosen and how many files it classifies', async () => {
    await mount({
      ...status,
      invalid: 2,
      problems: ['Row 7: no source path.', 'Row 9: no category.'],
    });
    expect(text('dd code')).toBe(status.path);
    expect(text('.counts')).toBe('5,770 files classified · 2 rows could not be read');
    expect([...host.querySelectorAll('.problems li')].map((item) => item.textContent)).toEqual([
      'Row 7: no source path.',
      'Row 9: no category.',
    ]);
    expect(button('Choose another…')).toBeDefined();
  });

  it('says why the catalogue chosen cannot be read', async () => {
    await mount({ ...status, rows: 0, error: 'Cannot read the catalogue.' });
    expect(text('[role="status"]')).toBe('Cannot read the catalogue.');
    expect(host.querySelector('.counts')).toBeNull();
  });

  it('chooses a catalogue, and shows it once the indexer says it changed', async () => {
    await mount(null);
    choose = () => Promise.resolve(status);
    worker.respond('getCatalogue', () => status);

    button('Choose catalogue…')?.click();
    await render();
    worker.emit('catalogueChanged', null);
    await render();

    expect(text('dd code')).toBe(status.path);
  });

  it('says why a file chosen cannot be used', async () => {
    await mount(null);
    choose = () =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'catalogue:choose': Error: This file is not a classification catalogue: it has no “Source path” column.",
        ),
      );

    button('Choose catalogue…')?.click();
    await render();

    expect(text('[role="alert"]')).toBe(
      'This file is not a classification catalogue: it has no “Source path” column.',
    );
  });

  it('stops using the catalogue', async () => {
    worker.respond('forgetCatalogue', () => undefined);
    await mount(status);

    button('Stop using it')?.click();
    await render();

    expect(worker.callsTo('forgetCatalogue')).toEqual([[]]);
  });
});
