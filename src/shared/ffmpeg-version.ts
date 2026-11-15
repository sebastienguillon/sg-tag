/**
 * FFmpeg versions, as ffmpeg and ffprobe report them, against the releases listed on ffmpeg.org.
 * Both tools come with every FFmpeg release.
 */

/** An index of the source archives of every release (`ffmpeg-9.0.2.tar.xz`…). */
export const FFMPEG_RELEASES_URL = 'https://ffmpeg.org/releases/';
/** Where to get FFmpeg for each platform. */
export const FFMPEG_DOWNLOAD_PAGE = 'https://ffmpeg.org/download.html';

/** How an installed version compares with the latest release. */
export type ReleaseComparison = 'outdated' | 'current' | 'unknown';

/**
 * The release a version names: `7.1.1` → [7, 1, 1], also with a build suffix
 * (`7.1-full_build-www.gyan.dev`, `6.1.1-3ubuntu5`) or a git tag prefix (`n7.1`). `null` for the
 * development builds numbered after a commit (`N-118385-g0225fe857d`, `2025-01-15-git-4f3c9f2f03`).
 */
export function releaseNumber(version: string): readonly number[] | null {
  const match = /^n?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) {
    return null;
  }
  const [, major = '', minor = '', patch = '0'] = match;
  return [Number(major), Number(minor), Number(patch)];
}

/** Negative if release `a` is older than `b`; `7.1` and `7.1.0` are the same release. */
export function compareReleases(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** The newest release in the index at `FFMPEG_RELEASES_URL`; `null` if it lists none. */
export function newestRelease(listing: string): string | null {
  let newest: { readonly version: string; readonly number: readonly number[] } | null = null;
  for (const [, version = ''] of listing.matchAll(/ffmpeg-(\d+(?:\.\d+)+)\.tar\./g)) {
    const number = releaseNumber(version);
    if (number !== null && (newest === null || compareReleases(number, newest.number) > 0)) {
      newest = { version, number };
    }
  }
  return newest?.version ?? null;
}

/** `unknown` for development builds, and when the tool did not say its version. */
export function compareWithRelease(installed: string | null, latest: string): ReleaseComparison {
  const ours = installed === null ? null : releaseNumber(installed);
  const theirs = releaseNumber(latest);
  if (ours === null || theirs === null) {
    return 'unknown';
  }
  return compareReleases(ours, theirs) < 0 ? 'outdated' : 'current';
}
