import { describe, expect, it } from 'vitest';
import { createTestLibrary } from '../testing/test-library';

describe('FilesRepository', () => {
  it('only hands out the paths of videos that are on disk, for streaming', () => {
    const { files, addFile } = createTestLibrary();
    const clip = addFile('trips/clip.mov');
    const photo = addFile('trips/photo.jpg');
    const gone = addFile('trips/gone.mp4');
    files.markMissing(gone, 1);

    expect(files.videoPathOf(clip)).toBe('/library/trips/clip.mov');
    expect(files.videoPathOf(photo)).toBeNull();
    expect(files.videoPathOf(gone)).toBeNull();
    expect(files.videoPathOf(999)).toBeNull();
  });
});
