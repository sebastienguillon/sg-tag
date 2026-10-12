import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { FileDetails } from '@shared/model';
import { isPlayable } from './playback';
import { VideoPreview } from './video-preview';

const clip: FileDetails = {
  id: 7,
  name: 'clip.mp4',
  kind: 'video',
  format: 'MP4',
  size: 12_300_000,
  mtimeMs: 42,
  width: 1920,
  height: 1080,
  durationMs: 65_000,
  offline: false,
  path: '/library/clip.mp4',
  folder: '',
  rootPath: '/library',
  birthtimeMs: null,
  codec: 'h264',
  missing: false,
  tags: [],
  copies: [],
};

describe('isPlayable', () => {
  const hevcDecoder = (type: string): string => (type.includes('hvc1') ? 'probably' : '');
  const none = (): string => '';

  it('plays the containers and codecs Chromium decodes', () => {
    expect(isPlayable(clip, none)).toBe(true);
    expect(isPlayable({ ...clip, format: 'WEBM', codec: 'vp9' }, none)).toBe(true);
    expect(isPlayable({ ...clip, format: 'MKV', codec: 'av1' }, none)).toBe(true);
  });

  it('plays HEVC only where the platform decodes it', () => {
    const hevc = { ...clip, format: 'MOV', codec: 'hevc' };
    expect(isPlayable(hevc, hevcDecoder)).toBe(true);
    expect(isPlayable(hevc, none)).toBe(false);
  });

  it('leaves other containers and codecs to the system player', () => {
    expect(isPlayable({ ...clip, format: 'MTS' }, none)).toBe(false);
    expect(isPlayable({ ...clip, format: 'MOV', codec: 'prores' }, none)).toBe(false);
    expect(isPlayable({ ...clip, kind: 'image', format: 'JPG' }, none)).toBe(false);
  });

  it('tries when the codec is unknown', () => {
    expect(isPlayable({ ...clip, codec: null }, none)).toBe(true);
  });
});

describe('VideoPreview', () => {
  let fixture: ComponentFixture<VideoPreview>;
  let host: HTMLElement;

  async function show(file: FileDetails): Promise<void> {
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('poster', `thumb://file/${file.id}?v=${file.mtimeMs}`);
    await fixture.whenStable();
  }

  beforeEach(() => {
    fixture = TestBed.createComponent(VideoPreview);
    host = fixture.nativeElement as HTMLElement;
  });

  it('shows the thumbnail, and plays the video only when asked to', async () => {
    await show(clip);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('thumb://file/7?v=42');
    expect(host.querySelector('video')).toBeNull();

    host.querySelector<HTMLButtonElement>('button.play')?.click();
    await fixture.whenStable();
    const video = host.querySelector('video');
    expect(video?.getAttribute('src')).toBe('media://file/7?v=42');
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(document.activeElement).toBe(video);
  });

  it('falls back to the thumbnail when the video cannot be decoded', async () => {
    await show(clip);
    host.querySelector<HTMLButtonElement>('button.play')?.click();
    await fixture.whenStable();
    host.querySelector('video')?.dispatchEvent(new Event('error'));
    await fixture.whenStable();

    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('button.play')).toBeNull();
    expect(host.querySelector('.note')?.textContent).toContain('Can’t play this video here');
  });

  it('says upfront when a format cannot play, and offers nothing for files out of reach', async () => {
    await show({ ...clip, format: 'MTS' });
    expect(host.querySelector('button.play')).toBeNull();
    expect(host.querySelector('.note')).not.toBeNull();

    await show({ ...clip, id: 8, offline: true });
    expect(host.querySelector('button.play')).toBeNull();
    expect(host.querySelector('.note')).toBeNull();
  });

  it('goes back to the thumbnail when another file is shown', async () => {
    await show(clip);
    host.querySelector<HTMLButtonElement>('button.play')?.click();
    await fixture.whenStable();

    await show({ ...clip, tags: [{ id: 1, path: 'trips' }] });
    expect(host.querySelector('video')).not.toBeNull();

    await show({ ...clip, id: 9 });
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('button.play')).not.toBeNull();
  });
});
