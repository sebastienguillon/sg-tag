import type { Tag } from '@shared/model';

/**
 * How many tags are below each of `tags`, at any depth, each counted once however many ways it is
 * reached: with Europe › France › Paris and Europe › Capitals › Paris, Europe has three tags below
 * it, not four. Tags with none are left out.
 *
 * Worked out for every tag at once, in time close to the number of links for the shapes tags take.
 * Where every tag below a tag has one parent tag, nothing below it is reached two ways, and its
 * count is the sum of those of its child tags, each plus one. Only the other tags, above a tag with
 * several parent tags, have the tags below them walked one by one, and even then not below a tag
 * whose own count was summed: what is below it is reached only through it.
 *
 * A loop, which the library refuses, makes the tags in it walked one by one: nothing hangs.
 */
export function countTagsBelow(tags: readonly Tag[]): ReadonlyMap<number, number> {
  const known = new Set(tags.map((tag) => tag.id));
  const children = new Map<number, number[]>();
  const parentCounts = new Map<number, number>();
  for (const tag of tags) {
    for (const parentId of tag.parentIds) {
      if (!known.has(parentId)) {
        continue;
      }
      const list = children.get(parentId);
      if (list) {
        list.push(tag.id);
      } else {
        children.set(parentId, [tag.id]);
      }
      parentCounts.set(tag.id, (parentCounts.get(tag.id) ?? 0) + 1);
    }
  }

  const summed = sumCounts(tags, children, parentCounts);
  const counts = new Map<number, number>();
  for (const tag of tags) {
    const count = summed.get(tag.id) ?? walkBelow(tag.id, children, summed);
    if (count > 0) {
      counts.set(tag.id, count);
    }
  }
  return counts;
}

/**
 * The count of each tag every tag below which has one parent tag, from the bottom up: the sum of
 * those of its child tags, each plus one. A tag with a child tag that has several parent tags, or
 * that has no count of its own, gets none.
 */
function sumCounts(
  tags: readonly Tag[],
  children: ReadonlyMap<number, readonly number[]>,
  parentCounts: ReadonlyMap<number, number>,
): Map<number, number> {
  const summed = new Map<number, number>();
  const entered = new Set<number>();
  for (const root of tags) {
    if (entered.has(root.id)) {
      continue;
    }
    entered.add(root.id);
    // Depth first, without recursion: a chain of thousands of tags would overflow the stack.
    const stack = [{ id: root.id, next: 0 }];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const below = children.get(frame.id) ?? [];
      const child = below[frame.next];
      if (child !== undefined) {
        frame.next += 1;
        if (!entered.has(child)) {
          entered.add(child);
          stack.push({ id: child, next: 0 });
        }
        continue;
      }
      stack.pop();
      let count = 0;
      for (const id of below) {
        const childCount = summed.get(id);
        // Still being walked (a loop), or reached by another way as well: no sum.
        if (childCount === undefined || (parentCounts.get(id) ?? 0) > 1) {
          count = -1;
          break;
        }
        count += childCount + 1;
      }
      if (count >= 0) {
        summed.set(frame.id, count);
      }
    }
  }
  return summed;
}

/** The tags below `id`, each counted once, walked down to the tags whose count was summed. */
function walkBelow(
  id: number,
  children: ReadonlyMap<number, readonly number[]>,
  summed: ReadonlyMap<number, number>,
): number {
  const seen = new Set([id]);
  const stack = [...(children.get(id) ?? [])];
  let count = 0;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    count += 1;
    const below = summed.get(current);
    if (below === undefined) {
      for (const child of children.get(current) ?? []) {
        stack.push(child);
      }
    } else {
      count += below;
    }
  }
  return count;
}
