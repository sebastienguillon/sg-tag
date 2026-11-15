import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { MediaToolInfo } from '@shared/model';
import { MediaTool } from './media-tool';

const ffmpeg: MediaToolInfo = {
  path: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
  version: '7.1-full_build-www.gyan.dev',
  bundled: false,
};

describe('MediaTool', () => {
  let fixture: ComponentFixture<MediaTool>;
  let host: HTMLElement;

  const mount = async (tool: MediaToolInfo): Promise<void> => {
    fixture = TestBed.createComponent(MediaTool);
    fixture.componentRef.setInput('tool', tool);
    host = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  };
  const text = (element: Element | null | undefined): string =>
    element?.textContent.replace(/\s+/g, ' ').trim() ?? '';

  it('shows the version above the path', async () => {
    await mount(ffmpeg);
    expect(text(host.querySelector('.version'))).toBe('7.1-full_build-www.gyan.dev');
    expect(text(host.querySelector('code'))).toBe('C:\\ffmpeg\\bin\\ffmpeg.exe');
    expect(host.querySelector('.muted')).toBeNull();
  });

  it('says when the tool did not report its version', async () => {
    await mount({ ...ffmpeg, version: null });
    expect(text(host.querySelector('.muted'))).toBe('Unknown version');
  });

  it('says when the tool comes with SG Tag', async () => {
    await mount({ ...ffmpeg, bundled: true });
    expect(text(host.querySelector('.muted'))).toBe('Comes with SG Tag, which updates it');
  });
});
