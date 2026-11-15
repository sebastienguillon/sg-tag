import { FFMPEG_RELEASES_URL, newestRelease } from '@shared/ffmpeg-version';
import { errorMessage } from '@shared/rpc';

/** The index weighs about 400 kB: room for a slow connection. */
const TIMEOUT_MS = 20_000;

/**
 * The newest FFmpeg release that ffmpeg.org lists, e.g. `9.0.2`. Asked for only when the user checks
 * for updates in Settings. `fetch` is Electron's `net.fetch`, which follows the system's proxy.
 */
export async function latestFfmpegRelease(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<string> {
  let listing: string;
  try {
    const response = await fetch(FFMPEG_RELEASES_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    listing = await response.text();
  } catch (error) {
    throw new Error(`Cannot reach ffmpeg.org (${errorMessage(error)}).`, { cause: error });
  }
  const latest = newestRelease(listing);
  if (latest === null) {
    throw new Error('ffmpeg.org lists no release.');
  }
  return latest;
}
