import { describe, expect, it } from 'vitest';
import {
  compareReleases,
  compareWithRelease,
  newestRelease,
  releaseNumber,
} from './ffmpeg-version';

describe('releaseNumber', () => {
  it('reads release builds, whatever the builder appends', () => {
    expect(releaseNumber('7.1.1')).toEqual([7, 1, 1]);
    expect(releaseNumber('8.0')).toEqual([8, 0, 0]);
    expect(releaseNumber('7.1-full_build-www.gyan.dev')).toEqual([7, 1, 0]);
    expect(releaseNumber('6.1.1-3ubuntu5')).toEqual([6, 1, 1]);
    expect(releaseNumber('7.0.2-static')).toEqual([7, 0, 2]);
    expect(releaseNumber('n7.1')).toEqual([7, 1, 0]);
  });

  it('finds no release in development builds', () => {
    expect(releaseNumber('N-118385-g0225fe857d-20250127')).toBeNull();
    expect(releaseNumber('2025-01-15-git-4f3c9f2f03-full_build-www.gyan.dev')).toBeNull();
    expect(releaseNumber('')).toBeNull();
  });
});

describe('compareReleases', () => {
  it('compares each part as a number', () => {
    expect(compareReleases([7, 1, 1], [9, 0, 2])).toBeLessThan(0);
    expect(compareReleases([10, 0], [9, 0, 2])).toBeGreaterThan(0);
    expect(compareReleases([7, 10], [7, 9, 3])).toBeGreaterThan(0);
    expect(compareReleases([7, 1], [7, 1, 0])).toBe(0);
  });
});

describe('newestRelease', () => {
  it('picks the newest release of the index, by number rather than by name', () => {
    const listing = [
      'ffmpeg-9.0.tar.xz',
      'ffmpeg-9.0.2.tar.xz.asc',
      'ffmpeg-9.0.2.tar.xz',
      'ffmpeg-10.0.tar.bz2',
      'ffmpeg-8.1.3.tar.xz',
      'ffmpeg-snapshot.tar.bz2',
      'ffmpeg-10.1-rc1.tar.xz',
    ]
      .map((name) => `<a href="${name}">${name}</a>`)
      .join('\n');
    expect(newestRelease(listing)).toBe('10.0');
  });

  it('finds nothing in a page that lists no release', () => {
    expect(newestRelease('<html><body>Service unavailable</body></html>')).toBeNull();
  });
});

describe('compareWithRelease', () => {
  it('tells whether the latest release is newer than the version installed', () => {
    expect(compareWithRelease('7.1-full_build-www.gyan.dev', '9.0.2')).toBe('outdated');
    expect(compareWithRelease('9.0.2', '9.0.2')).toBe('current');
    expect(compareWithRelease('9.0', '9.0.0')).toBe('current');
    // Built from a newer release than ffmpeg.org lists yet.
    expect(compareWithRelease('9.1', '9.0.2')).toBe('current');
  });

  it('cannot compare development builds, nor a version the tool did not report', () => {
    expect(compareWithRelease('N-118385-g0225fe857d-20250127', '9.0.2')).toBe('unknown');
    expect(compareWithRelease(null, '9.0.2')).toBe('unknown');
  });
});
