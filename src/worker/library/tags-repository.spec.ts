import { describe, expect, it } from 'vitest';
import { createTestLibrary } from '../testing/test-library';
import { normalizeTagPath, tagKey } from './tags-repository';

describe('normalizeTagPath', () => {
  it('trims segments, collapses whitespace and drops empty segments', () => {
    expect(normalizeTagPath('  Trips / 2024//New   York  ')).toBe('Trips/2024/New York');
    expect(normalizeTagPath(' / ')).toBeNull();
  });
});

describe('tagKey', () => {
  it('folds ASCII letters only, as `COLLATE NOCASE` does', () => {
    expect(tagKey('Trips/JAPAN 2024')).toBe('trips/japan 2024');
    expect(tagKey('Été')).toBe('Été');
    expect(tagKey('Été')).not.toBe(tagKey('été'));
  });
});

describe('TagsRepository', () => {
  it('creates the hierarchy once, case-insensitively, keeping the first spelling', () => {
    const { tags, addFile } = createTestLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['Trips/Japan']);
    tags.addToFiles([b], ['trips/japan/Kyoto']);
    expect(tags.list().map(({ path, fileCount }) => [path, fileCount])).toEqual([
      ['Trips', 0],
      ['Trips/Japan', 1],
      ['Trips/Japan/Kyoto', 1],
    ]);
  });

  it('counts the tags it adds, once per file', () => {
    const { tags, addFile } = createTestLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['trips']);

    expect(tags.addToFiles([a, b, 999], ['Trips', 'family/kids', ' / '])).toBe(3);
    expect(tags.addToFiles([a, b], ['trips', 'family/kids'])).toBe(0);
  });

  it('lists the tag paths of each file, and counts tags and tagged files', () => {
    const { files, tags, addFile } = createTestLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    const gone = addFile('c.jpg', { missingSince: 1 });
    const untagged = addFile('d.jpg');
    tags.addToFiles([a], ['zoo', 'Beach', 'animals/cat']);
    tags.addToFiles([b, gone], ['beach']);

    expect(tags.pathsForFiles([a, b, untagged])).toEqual(
      new Map([
        [a, ['animals/cat', 'Beach', 'zoo']],
        [b, ['Beach']],
      ]),
    );
    expect(tags.count()).toBe(4);
    expect(tags.taggedFileCount()).toBe(3);
    files.delete([gone]);
    expect(tags.taggedFileCount()).toBe(2);
  });

  it('reports usage across a selection', () => {
    const { tags, addFile } = createTestLibrary();
    const files = [addFile('a.jpg'), addFile('b.jpg'), addFile('c.jpg')];
    tags.addToFiles(files, ['shared']);
    tags.addToFiles(files.slice(0, 1), ['solo']);
    expect(tags.forSelection(files).map(({ path, fileCount }) => [path, fileCount])).toEqual([
      ['shared', 3],
      ['solo', 1],
    ]);
  });

  it('copies tags from some files onto others', () => {
    const { tags, addFile } = createTestLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['shared', 'from-a']);
    tags.addToFiles([b], ['shared', 'from-b']);
    tags.copyTags([a, b], [a, b]);
    expect(tags.forFile(a).map((tag) => tag.path)).toEqual(['from-a', 'from-b', 'shared']);
    expect(tags.forFile(b).map((tag) => tag.path)).toEqual(['from-a', 'from-b', 'shared']);
  });

  it('prunes tags that end up unused, bottom-up', () => {
    const { tags, addFile } = createTestLibrary();
    const a = addFile('a.jpg');
    const b = addFile('b.jpg');
    tags.addToFiles([a], ['x/y/z']);
    tags.addToFiles([b], ['x/keep']);
    const z = tags.list().find((tag) => tag.path === 'x/y/z');
    tags.removeFromFiles([a], [z?.id ?? 0]);
    expect(tags.list().map((tag) => tag.path)).toEqual(['x', 'x/keep']);
  });
});
