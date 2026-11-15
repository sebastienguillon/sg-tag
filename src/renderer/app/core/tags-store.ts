import { computed, inject, Injectable, resource } from '@angular/core';
import type { Tag } from '@shared/model';
import { MAX_TAG_NAME_LENGTH, tagFold, tagKey, tagNameText } from '@shared/tag-names';
import { WorkerClient } from './worker-client';

const MAX_SUGGESTIONS = 8;

/** The end of a text that stops inside a word: on a letter, a digit or a mark. */
const ENDS_INSIDE_WORD = /[\p{L}\p{N}\p{M}]$/u;

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

/** Every tag in the library, for autocompletion. */
@Injectable({ providedIn: 'root' })
export class TagsStore {
  private readonly worker = inject(WorkerClient);

  private readonly list = resource({
    params: () => ({ connection: this.worker.generation() }),
    loader: () => this.worker.call('listTags'),
  });

  readonly tags = computed<readonly Tag[]>(() => this.list.value() ?? []);
  /** The tags were listed: until then, `tags` is empty whether or not tags exist. */
  readonly loaded = computed(() => this.list.hasValue());
  /** Each tag with its name as tags and searches compare it: worked out once, not per keystroke. */
  private readonly compared = computed(() =>
    this.tags().map((tag) => ({ tag, key: tagKey(tag.name), fold: tagFold(tag.name) })),
  );

  constructor() {
    this.worker.on('tagsChanged', () => {
      this.list.reload();
    });
  }

  /**
   * Tags whose name holds `text`, compared as the worker compares a search with a name (`tagFold`:
   * neither case, accents nor characters nobody sees count, so `ete` suggests `Été`). The name that
   * is the text comes first, then the names starting with it, then those with a word starting with
   * it, then the rest; most used first within each of these. `exclude` holds the ids of tags to
   * leave out.
   *
   * Nothing is suggested for a text longer than a name can be.
   */
  suggest(text: string, exclude: ReadonlySet<number> = new Set()): readonly Tag[] {
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
    return this.compared()
      .flatMap((candidate) => {
        const rank = exclude.has(candidate.tag.id) ? null : rankMatch(candidate.fold, fold);
        return rank === null ? [] : [{ ...candidate, rank }];
      })
      .sort((a, b) => {
        if (a.rank !== b.rank) {
          return a.rank - b.rank;
        }
        // Accents tell two tags apart: of `côte` and `côté`, the one typed is the one meant.
        if (a.rank === 0 && (a.key === key) !== (b.key === key)) {
          return a.key === key ? -1 : 1;
        }
        return b.tag.fileCount - a.tag.fileCount;
      })
      .slice(0, MAX_SUGGESTIONS)
      .map(({ tag }) => tag);
  }
}
