import { FFMPEG_RELEASES_URL } from '@shared/ffmpeg-version';
import { describe, expect, it } from 'vitest';
import { latestFfmpegRelease } from './ffmpeg-release';

describe('latestFfmpegRelease', () => {
  it('reads the newest release from the index on ffmpeg.org', async () => {
    const requested: string[] = [];
    const latest = await latestFfmpegRelease((url) => {
      requested.push(url);
      return Promise.resolve(
        new Response('<a href="ffmpeg-8.1.3.tar.xz">…</a> <a href="ffmpeg-9.0.2.tar.xz">…</a>'),
      );
    });
    expect(latest).toBe('9.0.2');
    expect(requested).toEqual([FFMPEG_RELEASES_URL]);
  });

  it('says when ffmpeg.org cannot be reached, or does not answer with the index', async () => {
    await expect(
      latestFfmpegRelease(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))),
    ).rejects.toThrow('Cannot reach ffmpeg.org (net::ERR_INTERNET_DISCONNECTED).');
    await expect(
      latestFfmpegRelease(() => Promise.resolve(new Response('Busy', { status: 503 }))),
    ).rejects.toThrow('Cannot reach ffmpeg.org (HTTP 503).');
    await expect(
      latestFfmpegRelease(() => Promise.resolve(new Response('<html>Moved</html>'))),
    ).rejects.toThrow('ffmpeg.org lists no release.');
  });
});
