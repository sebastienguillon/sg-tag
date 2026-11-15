import type { ElementRef } from '@angular/core';
import {
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Tag } from '@shared/model';
import { describeTagNameProblem, normalizeTagName } from '@shared/tag-names';
import { TagsStore } from '../../core/tags-store';
import { Icon } from '../../ui/icon/icon';

let nextId = 0;

/**
 * Tag entry with autocompletion (ARIA combobox). Enter or comma adds the highlighted suggestion,
 * or what is typed when none is highlighted; Tab is left alone, and moves the focus on.
 *
 * A text that cannot be the name of a tag is not added: it stays in the field to be corrected, and
 * the field says why.
 */
@Component({
  selector: 'app-tag-input',
  imports: [Icon],
  templateUrl: './tag-input.html',
  styleUrl: './tag-input.css',
})
export class TagInput {
  private readonly tags = inject(TagsStore);

  /** Ids of the tags already applied, left out of suggestions. */
  readonly exclude = input<ReadonlySet<number>>(new Set());
  /** A name to add, as a tag stores it (`normalizeTagName`). */
  readonly add = output<string>();

  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private readonly id = nextId++;
  protected readonly listId = `tag-suggestions-${this.id}`;
  /** Ties the field to the sentence that says why its text is refused. */
  protected readonly problemId = `tag-problem-${this.id}`;
  protected readonly text = signal('');
  protected readonly focused = signal(false);
  protected readonly suggestions = computed(() => this.tags.suggest(this.text(), this.exclude()));
  /**
   * The place of the highlighted suggestion in the list, -1 when none is.
   *
   * The suggestions are worked out again without any typing, each time the tags of the library or
   * of the selection are read again. The highlight then stays on its tag, wherever that tag now is
   * in the list: Enter would otherwise add the letters typed in place of the tag chosen. It goes
   * when the text changes, or when its tag is no longer suggested.
   */
  protected readonly active = linkedSignal<
    { readonly text: string; readonly suggestions: readonly Tag[] },
    number
  >({
    source: () => ({ text: this.text(), suggestions: this.suggestions() }),
    computation: ({ text, suggestions }, previous) => {
      const highlighted =
        previous?.source.text === text ? previous.source.suggestions[previous.value] : undefined;
      return highlighted ? suggestions.findIndex((tag) => tag.id === highlighted.id) : -1;
    },
  });
  /**
   * Why the text in the field cannot be the name of a tag, once it was asked to be added. Goes as
   * soon as the text changes: it is said of the text as it was.
   */
  protected readonly problem = linkedSignal<string, string | null>({
    source: this.text,
    computation: () => null,
  });
  protected readonly expanded = computed(() => this.focused() && this.suggestions().length > 0);
  protected readonly activeId = computed(() =>
    this.expanded() && this.active() >= 0 ? `${this.listId}-${this.active()}` : null,
  );

  focus(): void {
    this.input().nativeElement.focus();
  }

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.suggestions().length;
    switch (event.key) {
      case 'ArrowDown':
        if (count > 0) {
          this.active.update((index) => (index + 1) % count);
          event.preventDefault();
        }
        break;
      case 'ArrowUp':
        if (count > 0) {
          this.active.update((index) => (index <= 0 ? count - 1 : index - 1));
          event.preventDefault();
        }
        break;
      case 'Enter':
      case ',':
        event.preventDefault();
        this.commit(this.suggestions()[this.active()]?.name ?? this.text());
        break;
      case 'Escape':
        if (this.text() !== '') {
          event.preventDefault();
          event.stopPropagation();
          this.text.set('');
        }
        break;
      default:
        break;
    }
  }

  /** Adds `typed` when it can be the name of a tag, and empties the field; says why otherwise. */
  protected commit(typed: string): void {
    // Nothing typed is no name to refuse: the field loses its spaces, without a word.
    if (typed.trim() === '') {
      this.text.set('');
      return;
    }
    const check = normalizeTagName(typed);
    if (check.ok) {
      this.add.emit(check.name);
      this.text.set('');
    } else {
      // The text stays where it can be corrected: emptied, it would have to be typed all over.
      this.problem.set(describeTagNameProblem(check.problem));
    }
  }
}
