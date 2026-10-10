import { computed, inject, Injectable, resource } from '@angular/core';
import type { Tag } from '@shared/model';
import { WorkerClient } from './worker-client';

const MAX_SUGGESTIONS = 8;

/** Every tag in the library, for autocompletion. */
@Injectable({ providedIn: 'root' })
export class TagsStore {
  private readonly worker = inject(WorkerClient);

  private readonly list = resource({
    params: () => ({ connection: this.worker.generation() }),
    loader: () => this.worker.call('listTags'),
  });

  readonly tags = computed<readonly Tag[]>(() => this.list.value() ?? []);

  constructor() {
    this.worker.on('tagsChanged', () => {
      this.list.reload();
    });
  }

  /**
   * Tags whose path contains `text` (case-insensitive): whole-path prefix matches first, then
   * segment prefix matches, then the rest; most used first within each group.
   */
  suggest(text: string, exclude: ReadonlySet<string> = new Set()): readonly Tag[] {
    const needle = text.trim().toLocaleLowerCase();
    if (needle === '') {
      return [];
    }
    const rank = (path: string): number => {
      if (path.startsWith(needle)) {
        return 0;
      }
      return path.includes(`/${needle}`) ? 1 : 2;
    };
    return this.tags()
      .map((tag) => ({ tag, path: tag.path.toLocaleLowerCase() }))
      .filter(({ tag, path }) => path.includes(needle) && !exclude.has(tag.path))
      .sort((a, b) => {
        const byRank = rank(a.path) - rank(b.path);
        return byRank !== 0 ? byRank : b.tag.fileCount - a.tag.fileCount;
      })
      .slice(0, MAX_SUGGESTIONS)
      .map(({ tag }) => tag);
  }
}
