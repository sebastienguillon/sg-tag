import { formatDuration } from './duration-pipe';
import { formatFileSize } from './file-size-pipe';

describe('formatFileSize', () => {
  it('uses decimal units with sensible precision', () => {
    expect(formatFileSize(0, 'en-US')).toBe('0 B');
    expect(formatFileSize(999, 'en-US')).toBe('999 B');
    expect(formatFileSize(1_500, 'en-US')).toBe('1.5 kB');
    expect(formatFileSize(12_340_000, 'en-US')).toBe('12.3 MB');
    expect(formatFileSize(512_000_000, 'en-US')).toBe('512 MB');
    expect(formatFileSize(3_000_000_000_000_000, 'en-US')).toBe('3,000 TB');
  });

  it('follows the locale', () => {
    expect(formatFileSize(1_500, 'fr-FR')).toBe('1,5 kB');
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_400)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
});
