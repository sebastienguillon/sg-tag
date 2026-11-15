import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { FFMPEG_DOWNLOAD_PAGE } from '@shared/ffmpeg-version';
import type { MediaToolInfo } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { fakeDesktop, settle } from '../../testing/fake-worker-client';
import { FfmpegUpdate } from './ffmpeg-update';

const tool = (name: string, version: string | null = '7.1-full_build-www.gyan.dev') => ({
  path: `C:\\ffmpeg\\bin\\${name}.exe`,
  version,
  bundled: false,
});
const ffmpeg: MediaToolInfo = tool('ffmpeg');
const ffprobe: MediaToolInfo = tool('ffprobe');

describe('FfmpegUpdate', () => {
  let fixture: ComponentFixture<FfmpegUpdate>;
  let host: HTMLElement;
  let latest: () => Promise<string>;
  let checks: number;

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  const mount = async (tools: {
    ffmpeg: MediaToolInfo | null;
    ffprobe: MediaToolInfo | null;
  }): Promise<void> => {
    fixture = TestBed.createComponent(FfmpegUpdate);
    fixture.componentRef.setInput('ffmpeg', tools.ffmpeg);
    fixture.componentRef.setInput('ffprobe', tools.ffprobe);
    host = fixture.nativeElement as HTMLElement;
    await render();
  };
  const text = (element: Element | null | undefined): string =>
    element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const checkButton = (): HTMLButtonElement | null => host.querySelector('button');
  const status = (): string => text(host.querySelector('[role="status"]'));
  const check = async (): Promise<void> => {
    checkButton()?.click();
    await render();
  };

  beforeEach(() => {
    checks = 0;
    latest = () => Promise.resolve('9.0.2');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP,
          useValue: {
            ...fakeDesktop,
            latestFfmpegRelease: () => {
              checks++;
              return latest();
            },
          },
        },
      ],
    });
  });

  it('offers one check for both tools, and asks ffmpeg.org nothing until asked', async () => {
    await mount({ ffmpeg, ffprobe });
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(text(checkButton())).toBe('Check for updates to ffmpeg and ffprobe');
    expect(status()).toBe('');
    expect(host.querySelector('.install')).toBeNull();
    expect(checks).toBe(0);
  });

  it('links to the download page when ffmpeg.org has a newer release', async () => {
    await mount({ ffmpeg, ffprobe });
    await check();
    expect(checks).toBe(1);
    expect(status()).toBe(
      'ffmpeg and ffprobe are out of date: FFmpeg 9.0.2 is available. Download it from ffmpeg.org',
    );
    const link = host.querySelector<HTMLAnchorElement>('[role="status"] a');
    expect(link?.getAttribute('href')).toBe(FFMPEG_DOWNLOAD_PAGE);
    expect(link?.target).toBe('_blank');
  });

  it('says when both are up to date', async () => {
    await mount({ ffmpeg: tool('ffmpeg', '9.0.2'), ffprobe: tool('ffprobe', '9.0.2') });
    await check();
    expect(status()).toBe('ffmpeg and ffprobe are up to date: 9.0.2 is the latest FFmpeg release.');
    expect(host.querySelector('[role="status"] a')).toBeNull();
  });

  it('names the tool that is out of date when the other is not', async () => {
    await mount({ ffmpeg: tool('ffmpeg', '9.0.2'), ffprobe });
    await check();
    expect(status()).toBe(
      'ffprobe is out of date: FFmpeg 9.0.2 is available. Download it from ffmpeg.org',
    );
  });

  it('cannot compare development builds, but still links to the download page', async () => {
    const build = 'N-118385-g0225fe857d-20250127';
    await mount({ ffmpeg: tool('ffmpeg', build), ffprobe: tool('ffprobe', build) });
    await check();
    expect(status()).toBe(
      'The latest FFmpeg release is 9.0.2: the ffmpeg and ffprobe builds cannot be compared with it. Download it from ffmpeg.org',
    );
  });

  it('shows the check under way once, then why it failed, and checks again on request', async () => {
    const answer = Promise.withResolvers<string>();
    latest = () => answer.promise;
    await mount({ ffmpeg, ffprobe });
    await check();
    expect(status()).toBe('Checking ffmpeg.org…');
    expect(checkButton()?.getAttribute('aria-disabled')).toBe('true');
    await check();
    expect(checks).toBe(1);

    answer.reject(
      new Error(
        "Error invoking remote method 'updates:latest-ffmpeg': Error: Cannot reach ffmpeg.org (net::ERR_INTERNET_DISCONNECTED).",
      ),
    );
    await render();
    expect(status()).toBe('Cannot reach ffmpeg.org (net::ERR_INTERNET_DISCONNECTED).');
    expect(checkButton()?.getAttribute('aria-disabled')).toBeNull();

    latest = () => Promise.resolve('9.0.2');
    await check();
    expect(checks).toBe(2);
    expect(status()).toBe(
      'ffmpeg and ffprobe are out of date: FFmpeg 9.0.2 is available. Download it from ffmpeg.org',
    );
  });

  it('offers to install FFmpeg when neither tool is found', async () => {
    await mount({ ffmpeg: null, ffprobe: null });
    expect(checkButton()).toBeNull();
    expect(text(host.querySelector('.install'))).toBe(
      'ffmpeg and ffprobe come with FFmpeg: install it from ffmpeg.org, then restart SG Tag.',
    );
    expect(host.querySelector('.install a')?.getAttribute('href')).toBe(FFMPEG_DOWNLOAD_PAGE);
  });

  it('checks the tool found, and offers to install the one missing', async () => {
    await mount({ ffmpeg, ffprobe: null });
    expect(text(checkButton())).toBe('Check for updates to ffmpeg');
    expect(text(host.querySelector('.install'))).toBe(
      'ffprobe comes with FFmpeg: install it from ffmpeg.org, then restart SG Tag.',
    );
    await check();
    expect(status()).toBe(
      'ffmpeg is out of date: FFmpeg 9.0.2 is available. Download it from ffmpeg.org',
    );
  });

  it('leaves out a tool shipped with SG Tag, which updates it', async () => {
    await mount({ ffmpeg: { ...ffmpeg, bundled: true }, ffprobe });
    expect(text(checkButton())).toBe('Check for updates to ffprobe');
  });
});
