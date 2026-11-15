import type { Tag } from '@shared/model';
import { countTagsBelow } from './tags-below';

const tag = (id: number, parentIds: readonly number[] = []): Tag => ({
  id,
  name: `Tag ${id}`,
  aliases: [],
  parentIds,
  fileCount: 0,
});

/** The tags below each tag, by brute force: the tags reached going down, again and again. */
function bruteForce(tags: readonly Tag[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const top of tags) {
    const seen = new Set([top.id]);
    for (let grown = true; grown;) {
      const before = seen.size;
      for (const other of tags) {
        if (other.parentIds.some((id) => seen.has(id))) {
          seen.add(other.id);
        }
      }
      grown = seen.size > before;
    }
    if (seen.size > 1) {
      counts.set(top.id, seen.size - 1);
    }
  }
  return counts;
}

describe('countTagsBelow', () => {
  it('counts every tag below a tag, at any depth, and leaves out the tags with none', () => {
    // Europe › France › Paris › Montmartre, and Lyon below France.
    const counts = countTagsBelow([tag(1), tag(2, [1]), tag(3, [2]), tag(4, [3]), tag(5, [2])]);
    expect([...counts]).toEqual([
      [1, 4],
      [2, 3],
      [3, 1],
    ]);
  });

  it('counts a tag reached two ways once, with the tags below it', () => {
    // Europe › France › Paris and Europe › Capitals › Paris; Montmartre below Paris.
    const europe = tag(1);
    const france = tag(2, [1]);
    const capitals = tag(3, [1]);
    const paris = tag(4, [2, 3]);
    const montmartre = tag(5, [4]);
    const counts = countTagsBelow([europe, france, capitals, paris, montmartre]);
    expect(counts.get(europe.id)).toBe(4);
    expect(counts.get(france.id)).toBe(2);
    expect(counts.get(capitals.id)).toBe(2);
    expect(counts.get(paris.id)).toBe(1);
    expect(counts.has(montmartre.id)).toBe(false);
  });

  it('agrees with walking every tag down, whatever the shape', () => {
    // Each tag below up to three of the tags listed before it: a tag is often reached many ways.
    let seed = 7;
    const random = (): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const tags: Tag[] = [];
    for (let id = 1; id <= 300; id++) {
      const parents = new Set<number>();
      const wanted = Math.floor(random() * 4);
      while (id > 1 && parents.size < Math.min(wanted, id - 1)) {
        parents.add(1 + Math.floor(random() * (id - 1)));
      }
      tags.push(tag(id, [...parents]));
    }
    expect(countTagsBelow(tags)).toEqual(bruteForce(tags));
  });

  it('stays fast on 20,000 tags, a chain of them included', () => {
    const tags: Tag[] = [];
    // A chain of 5,000 tags, each below the one before.
    for (let id = 1; id <= 5_000; id++) {
      tags.push(tag(id, id === 1 ? [] : [id - 1]));
    }
    // 15,000 more in a tree of eight child tags each, some of them below the top tag as well.
    tags.push(tag(5_001));
    for (let id = 5_002; id <= 20_000; id++) {
      const parent = 5_001 + Math.floor((id - 5_002) / 8);
      tags.push(tag(id, id % 500 === 0 ? [parent, 5_001] : [parent]));
    }
    const started = performance.now();
    const counts = countTagsBelow(tags);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(counts.get(1)).toBe(4_999);
    expect(counts.get(5_001)).toBe(14_999);
  });

  it('ends on a loop, which the library never holds', () => {
    const counts = countTagsBelow([tag(1, [2]), tag(2, [1]), tag(3, [2])]);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(2);
  });

  it('leaves out parent tags it is not given', () => {
    expect([...countTagsBelow([tag(1, [99])])]).toEqual([]);
  });
});
