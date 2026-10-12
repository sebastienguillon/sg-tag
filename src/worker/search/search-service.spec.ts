import type { SortOrder } from '@shared/model';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestLibrary } from '../testing/test-library';
import { createTestLibrary } from '../testing/test-library';
import { SearchService } from './search-service';

const NEWEST: SortOrder = { field: 'modified', direction: 'desc' };

describe('SearchService', () => {
  let library: TestLibrary;
  let service: SearchService;
  let offline: number[];
  const ids: Record<string, number> = {};

  const search = (query: string, sort: SortOrder = NEWEST): number[] =>
    Array.from(service.search({ query, sort }).ids);

  beforeEach(() => {
    library = createTestLibrary();
    offline = [];
    service = new SearchService(library.db, () => offline);
    ids['beach'] = library.addFile('2024/Été à Kyōto/beach.jpg', { size: 5_000_000 });
    ids['sunset'] = library.addFile('2024/Été à Kyōto/sunset.HEIC', { size: 2_000_000 });
    ids['clip'] = library.addFile('videos/clip.mp4', { size: 50_000_000 });
    ids['scan'] = library.addFile('scan_01.jpeg', { size: 300_000 });
    library.tags.addToFiles([ids['beach'] ?? 0], ['Trips/2024/Japan']);
    library.tags.addToFiles([ids['clip'] ?? 0], ['family/kids', 'draft']);
  });

  it('lists everything newest first for an empty query', () => {
    expect(search('')).toEqual([ids['scan'], ids['clip'], ids['sunset'], ids['beach']]);
  });

  it('matches substrings of names and folders, ignoring case and diacritics', () => {
    expect(search('kyoto')).toEqual([ids['sunset'], ids['beach']]);
    expect(search('"ETE A"')).toEqual([ids['sunset'], ids['beach']]);
    expect(search('unse')).toEqual([ids['sunset']]);
  });

  it('handles terms shorter than a trigram and LIKE wildcards literally', () => {
    expect(search('cl')).toEqual([ids['clip']]);
    expect(search('n_0')).toEqual([ids['scan']]);
    expect(search('%')).toEqual([]);
  });

  it('matches free text against tag paths too', () => {
    expect(search('japan')).toEqual([ids['beach']]);
  });

  it('matches tags by whole segments, including descendants', () => {
    expect(search('tag:trips')).toEqual([ids['beach']]);
    expect(search('tag:japan')).toEqual([ids['beach']]);
    expect(search('tag:2024/japan')).toEqual([ids['beach']]);
    expect(search('tag:jap')).toEqual([]);
    expect(search('tag:FAMILY')).toEqual([ids['clip']]);
    expect(search('tag:draft,trips')).toEqual([ids['clip'], ids['beach']]);
  });

  it('combines terms with AND and supports negation', () => {
    expect(search('kyoto -tag:trips')).toEqual([ids['sunset']]);
    expect(search('-type:image')).toEqual([ids['clip']]);
    expect(search('is:untagged')).toEqual([ids['scan'], ids['sunset']]);
    expect(search('is:tagged type:video')).toEqual([ids['clip']]);
  });

  it('expands extension aliases and compares sizes', () => {
    expect(search('ext:jpg')).toEqual([ids['scan'], ids['beach']]);
    expect(search('ext:heic')).toEqual([ids['sunset']]);
    expect(search('size:>4mb')).toEqual([ids['clip'], ids['beach']]);
    expect(search('size:1mb..10mb')).toEqual([ids['sunset'], ids['beach']]);
  });

  it('hides missing files unless asked for them', () => {
    library.files.markMissing(ids['beach'] ?? 0, Date.now());
    // Untagged: only kept a while, in case it moved.
    library.files.markMissing(ids['scan'] ?? 0, Date.now());
    expect(search('kyoto')).toEqual([ids['sunset']]);
    expect(search('is:missing')).toEqual([ids['beach']]);
  });

  it('lists files that have an identical copy, copies side by side, largest first', () => {
    const beachCopy = library.addFile('backup/beach.jpg', { size: 5_000_000 });
    const clipCopy = library.addFile('backup/clip.mp4', { size: 50_000_000 });
    const hash = library.db.prepare<[string, number]>(
      'UPDATE files SET content_hash = ? WHERE id = ?',
    );
    hash.run('beach', ids['beach'] ?? 0);
    hash.run('beach', beachCopy);
    hash.run('clip', ids['clip'] ?? 0);
    hash.run('clip', clipCopy);
    hash.run('scan', ids['scan'] ?? 0);

    expect(search('is:duplicate')).toEqual([clipCopy, ids['clip'], beachCopy, ids['beach']]);
    expect(search('-is:duplicate')).toEqual([ids['scan'], ids['sunset']]);
    library.files.markMissing(beachCopy, Date.now());
    expect(search('is:duplicate')).toEqual([clipCopy, ids['clip']]);
  });

  it('filters offline roots on request', () => {
    expect(search('is:offline')).toEqual([]);
    offline = library.roots.list().map((root) => root.id);
    expect(search('is:offline')).toHaveLength(4);
  });

  it('sorts by name and size in both directions', () => {
    expect(search('', { field: 'name', direction: 'asc' })).toEqual([
      ids['beach'],
      ids['clip'],
      ids['scan'],
      ids['sunset'],
    ]);
    expect(search('', { field: 'size', direction: 'desc' })).toEqual([
      ids['clip'],
      ids['beach'],
      ids['sunset'],
      ids['scan'],
    ]);
  });
});
