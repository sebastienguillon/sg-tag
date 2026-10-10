import { TestBed } from '@angular/core/testing';
import type { FileSummary } from '@shared/model';
import { LibraryStore } from '../../core/library-store';
import { FileTile } from './file-tile';

const video: FileSummary = {
  id: 7,
  name: 'clip.mov',
  kind: 'video',
  format: 'MOV',
  size: 12_300_000,
  mtimeMs: 42,
  width: 1920,
  height: 1080,
  durationMs: 65_000,
  offline: true,
};

describe('FileTile', () => {
  it('shows the type badge, versioned thumbnail and hover details', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStore, useValue: { summary: () => video } }],
    });
    const fixture = TestBed.createComponent(FileTile);
    fixture.componentRef.setInput('fileId', 7);
    fixture.componentRef.setInput('index', 3);
    fixture.componentRef.setInput('selected', true);
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('option');
    expect(host.getAttribute('aria-selected')).toBe('true');
    expect(host.dataset['index']).toBe('3');
    expect(host.querySelector('.badge')?.textContent.trim()).toBe('MOV');
    expect(host.querySelector('.badge')?.classList).toContain('video');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('thumb://file/7?v=42');
    expect(host.querySelector('.offline')).not.toBeNull();
    expect(host.querySelector('.meta')?.textContent.replace(/\s+/g, ' ').trim()).toBe(
      '12.3 MB · 1920×1080 · 1:05',
    );
  });
});
