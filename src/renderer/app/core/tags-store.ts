import { computed, inject, Injectable, resource } from '@angular/core';
import type { Tag, TagRef } from '@shared/model';
import { MAX_TAG_NAME_LENGTH, tagFold, tagKey, tagNameText } from '@shared/tag-names';
import { WorkerClient } from './worker-client';

const MAX_SUGGESTIONS = 8;

/** The end of a text that stops inside a word: on a letter, a digit or a mark. */
const ENDS_INSIDE_WORD = /[\p{L}\p{N}\p{M}]$/u;

/** A tag suggested for what is typed, and the name it was found by. */
export interface TagSuggestion {
  readonly tag: Tag;
  /** The alias that matched what is typed; `null` when the tag's name matched as well or better. */
  readonly alias: string | null;
}

/** One name of a tag, its own or an alias, as tags and searches compare it. */
interface ComparedName {
  readonly tag: Tag;
  readonly name: string;
  readonly alias: boolean;
  readonly key: string;
  readonly fold: string;
}

/** How well one name of a tag matches what is typed. */
interface Match {
  readonly name: ComparedName;
  readonly rank: number;
  /** The name is the text typed with its accents: of `côte` and `côté`, the one meant. */
  readonly exact: boolean;
}

/**
 * How well `name` matches `text`, both as a search compares them (`tagFold`), best first: 0 when
 * the name is the text, 1 when it starts with it, 2 when one of its words does, 3 when it holds it
 * inside a word; `null` when it does not hold it.
 */
function rankMatch(name: string, text: string): number | null {
  if (name.startsWith(text)) {
    return name.length === text.length ? 0 : 1;
  }
  let rank: number | null = null;
  for (let at = name.indexOf(text, 1); at !== -1; at = name.indexOf(text, at + 1)) {
    // Two units back: the character before may be a surrogate pair.
    if (!ENDS_INSIDE_WORD.test(name.slice(Math.max(0, at - 2), at))) {
      return 2;
    }
    rank = 3;
  }
  return rank;
}

/** Orders two matches of a text: by rank, then the name typed with its accents first. */
function byRank(a: Match, b: Match): number {
  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }
  return Number(b.exact) - Number(a.exact);
}

/** Every tag in the library, for autocompletion, and how tags stand above one another. */
@Injectable({ providedIn: 'root' })
export class TagsStore {
  private readonly worker = inject(WorkerClient);

  private readonly list = resource({
    params: () => ({ connection: this.worker.generation() }),
    loader: () => this.worker.call('listTags'),
  });

  /** In the order the worker sorts names. */
  readonly tags = computed<readonly Tag[]>(() => (this.list.hasValue() ? this.list.value() : []));
  /** The tags were listed: until then, `tags` is empty whether or not tags exist. */
  readonly loaded = computed(() => this.list.hasValue());
  readonly byId = computed(() => new Map(this.tags().map((tag) => [tag.id, tag])));
  /** Where each tag stands in `tags`, to put tags found by walking up or down in name order. */
  private readonly places = computed(
    () => new Map(this.tags().map((tag, place) => [tag.id, place])),
  );
  /** The child tags of each tag that has any, one step down. */
  private readonly childIds = computed(() => {
    const children = new Map<number, number[]>();
    for (const tag of this.tags()) {
      for (const parentId of tag.parentIds) {
        const list = children.get(parentId);
        if (list) {
          list.push(tag.id);
        } else {
          children.set(parentId, [tag.id]);
        }
      }
    }
    return children;
  });
  /**
   * Each name and alias of each tag as tags and searches compare it: worked out once, not per
   * keystroke. A tag's own name comes before its aliases.
   */
  private readonly names = computed<readonly ComparedName[]>(() =>
    this.tags().flatMap((tag) =>
      [tag.name, ...tag.aliases].map((name, index) => ({
        tag,
        name,
        alias: index > 0,
        key: tagKey(name),
        fold: tagFold(name),
      })),
    ),
  );
  /** The tag each name or alias is, by identity (`tagKey`): one tag at most, as in the worker. */
  private readonly byKey = computed(
    () => new Map(this.names().map((name) => [name.key, name.tag])),
  );
  /** The tags each name or alias is, by what a search compares (`tagFold`): accents aside. */
  private readonly byFold = computed(() => {
    const tags = new Map<string, Tag[]>();
    for (const name of this.names()) {
      const found = tags.get(name.fold);
      if (!found) {
        tags.set(name.fold, [name.tag]);
      } else if (!found.includes(name.tag)) {
        found.push(name.tag);
      }
    }
    return tags;
  });

  constructor() {
    this.worker.on('tagsChanged', () => {
      this.list.reload();
    });
  }

  /**
   * Tags whose name or one of whose aliases holds `text`, compared as the worker compares a search
   * with a name (`tagFold`: neither case, accents nor characters nobody sees count, so `ete`
   * suggests `Été`). The name that is the text comes first, then the names starting with it, then
   * those with a word starting with it, then the rest; most used first within each of these. A tag
   * comes once, by the name or alias that matches best, its own name when both match as well.
   * `exclude` holds the ids of tags to leave out.
   *
   * Nothing is suggested for a text longer than a name can be.
   */
  suggest(text: string, exclude: ReadonlySet<number> = new Set()): readonly TagSuggestion[] {
    // Before the text is composed: the field takes any paste, and composing a long run of
    // combining marks, again at each keystroke, would freeze the window for seconds.
    if (text.length > MAX_TAG_NAME_LENGTH) {
      return [];
    }
    const typed = tagNameText(text);
    const key = tagKey(typed);
    const fold = tagFold(typed);
    // Nothing typed, or accents alone: every name would hold it.
    if (fold === '') {
      return [];
    }
    const best = new Map<number, Match>();
    for (const name of this.names()) {
      const rank = exclude.has(name.tag.id) ? null : rankMatch(name.fold, fold);
      if (rank === null) {
        continue;
      }
      const match: Match = { name, rank, exact: rank === 0 && name.key === key };
      const kept = best.get(name.tag.id);
      // An alias only takes the place of a name that matches less well: names come first.
      if (kept === undefined || byRank(match, kept) < 0) {
        best.set(name.tag.id, match);
      }
    }
    return [...best.values()]
      .sort((a, b) => {
        const rank = byRank(a, b);
        return rank === 0 ? b.name.tag.fileCount - a.name.tag.fileCount : rank;
      })
      .slice(0, MAX_SUGGESTIONS)
      .map(({ name }) => ({ tag: name.tag, alias: name.alias ? name.name : null }));
  }

  /**
   * The ids of the tags whose name or one of whose aliases holds `text`, compared as `suggest`
   * compares them (`tagFold`); `null` when every tag does: nothing typed, or accents alone. No tag
   * holds a text longer than a name can be.
   */
  holding(text: string): ReadonlySet<number> | null {
    if (text.length > MAX_TAG_NAME_LENGTH) {
      return new Set();
    }
    const fold = tagFold(tagNameText(text));
    if (fold === '') {
      return null;
    }
    const ids = new Set<number>();
    for (const name of this.names()) {
      if (name.fold.includes(fold)) {
        ids.add(name.tag.id);
      }
    }
    return ids;
  }

  /**
   * The tag that `text` names, as the tag input takes it: the tag whose name or alias it is, letter
   * case and characters nobody sees aside (`tagKey`); else the one tag whose name or alias it is
   * without accents too (`tagFold`), so that `Egypte` is `Égypte`; else none, and `text` would make
   * a tag of its own.
   */
  resolve(text: string): Tag | null {
    if (text.length > MAX_TAG_NAME_LENGTH) {
      return null;
    }
    const typed = tagNameText(text);
    const named = this.byKey().get(tagKey(typed));
    if (named) {
      return named;
    }
    const folded = this.byFold().get(tagFold(typed));
    return folded?.length === 1 ? (folded[0] ?? null) : null;
  }

  /** Whether a tag has `text` as its name or one of its aliases (`tagKey`). */
  isName(text: string): boolean {
    return text.length <= MAX_TAG_NAME_LENGTH && this.byKey().has(tagKey(tagNameText(text)));
  }

  /** `tags` in the order the worker sorts names; those it did not list (yet) come last. */
  inNameOrder<T extends TagRef>(tags: readonly T[]): T[] {
    const places = this.places();
    const place = (tag: TagRef): number => places.get(tag.id) ?? Number.MAX_SAFE_INTEGER;
    return [...tags].sort((a, b) => place(a) - place(b));
  }

  /** The tags above tag `id`, at any depth: nearest first, then in name order. */
  above(id: number): readonly Tag[] {
    const byId = this.byId();
    return this.walk(id, (current) => byId.get(current)?.parentIds ?? []);
  }

  /** The tags below tag `id`, at any depth: nearest first, then in name order. */
  below(id: number): readonly Tag[] {
    const children = this.childIds();
    return this.walk(id, (current) => children.get(current) ?? []);
  }

  /** The tags reached from tag `id` by taking `step` again and again, each once, level by level. */
  private walk(id: number, step: (id: number) => readonly number[]): readonly Tag[] {
    const byId = this.byId();
    const places = this.places();
    const seen = new Set([id]);
    const found: Tag[] = [];
    let level = [id];
    while (level.length > 0) {
      const next: Tag[] = [];
      for (const current of level) {
        for (const reached of step(current)) {
          const tag = byId.get(reached);
          if (tag && !seen.has(reached)) {
            seen.add(reached);
            next.push(tag);
          }
        }
      }
      next.sort((a, b) => (places.get(a.id) ?? 0) - (places.get(b.id) ?? 0));
      found.push(...next);
      level = next.map((tag) => tag.id);
    }
    return found;
  }
}
