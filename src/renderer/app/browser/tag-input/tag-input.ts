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
import { describeTagNameProblem, normalizeTagName, tagNameText } from '@shared/tag-names';
import { TagsStore } from '../../core/tags-store';
import { Icon } from '../../ui/icon/icon';
import { quote } from '../../ui/format/quote';

let nextId = 0;

/** One line of the suggestions, and what choosing it does. */
interface Row {
  /** Who the line stands for, so that a highlight stays on it when the lines are worked out again. */
  readonly key: string;
  /**
   * `add`: adds the tag. `edit`: asks to edit a tag already added. `refuse`: says why the tag
   * cannot be chosen here (`note`). `create`: adds what is typed, which no tag is named.
   */
  readonly action: 'add' | 'edit' | 'refuse' | 'create';
  readonly tag: Tag | null;
  /** The tag's name, or the alias it was found by and its name: `Paname → Paris`. */
  readonly label: string;
  /** Said after the label: `already added — Enter to edit`, `is below Paris`, `new tag`. */
  readonly note: string | null;
  /** How many files carry the tag, for a tag that can be added. */
  readonly count: number | null;
}

/**
 * Tag entry with autocompletion (ARIA combobox), by a name or an alias. Enter or comma takes the
 * highlighted suggestion; with none highlighted, the tag that what is typed names (`TagsStore.
 * resolve`), or else what is typed, as a new tag. Tab is left alone, and moves the focus on.
 *
 * A text that cannot be the name of a tag is not added: it stays in the field to be corrected, and
 * the field says why. So does a tag that cannot be chosen here (`disabled`).
 *
 * The tag input of the details panel, and the pickers of the tag editor.
 */
@Component({
  selector: 'app-tag-input',
  imports: [Icon],
  templateUrl: './tag-input.html',
  styleUrl: './tag-input.css',
})
export class TagInput {
  private readonly tags = inject(TagsStore);

  /** The field's label and placeholder. */
  readonly label = input('Add a tag');
  /** Ids of tags left out of the suggestions, such as the parent tags a tag already has. */
  readonly exclude = input<ReadonlySet<number>>(new Set());
  /** Ids of the tags already applied: suggested as such, and chosen to be edited (`edit`). */
  readonly added = input<ReadonlySet<number>>(new Set());
  /**
   * Tags suggested but that cannot be chosen, each with why, said after its name: `is below Paris`.
   */
  readonly disabled = input<ReadonlyMap<number, string>>(new Map());
  /** Whether what is typed can be a new tag; otherwise only an existing tag can be chosen. */
  readonly allowNew = input(true);
  /** A name to add, as a tag stores it (`normalizeTagName`): an existing tag's, or a new one. */
  readonly add = output<string>();
  /** The id of a tag already applied (`added`), chosen to be edited. */
  readonly edit = output<number>();

  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  private readonly id = nextId++;
  protected readonly listId = `tag-suggestions-${this.id}`;
  /** Ties the field to the sentence that says why its text is refused. */
  protected readonly problemId = `tag-problem-${this.id}`;
  protected readonly text = signal('');
  protected readonly focused = signal(false);
  protected readonly rows = computed<readonly Row[]>(() => {
    const text = this.text();
    const added = this.added();
    const disabled = this.disabled();
    const rows = this.tags.suggest(text, this.exclude()).map(({ tag, alias }): Row => {
      const common = {
        key: `tag-${tag.id}`,
        tag,
        label: alias === null ? tag.name : `${alias} → ${tag.name}`,
      };
      const reason = disabled.get(tag.id);
      if (reason !== undefined) {
        return { ...common, action: 'refuse', note: reason, count: null };
      }
      if (added.has(tag.id)) {
        return { ...common, action: 'edit', note: 'already added — Enter to edit', count: null };
      }
      return { ...common, action: 'add', note: null, count: tag.fileCount };
    });
    // Last, and only when no tag has the name: one that differs by its accents is a tag of its
    // own, which this row makes on purpose.
    const check = this.allowNew() ? normalizeTagName(text) : null;
    if (check?.ok === true && !this.tags.isName(check.name)) {
      rows.push({
        key: 'new',
        action: 'create',
        tag: null,
        label: check.name,
        note: 'new tag',
        count: null,
      });
    }
    return rows;
  });
  /**
   * The place of the highlighted suggestion in the list, -1 when none is.
   *
   * The suggestions are worked out again without any typing, each time the tags of the library or
   * of the selection are read again. The highlight then stays on its line, wherever that line now
   * is in the list: Enter would otherwise add the letters typed in place of the tag chosen. It goes
   * when the text changes, or when its line is no longer there.
   */
  protected readonly active = linkedSignal<
    { readonly text: string; readonly rows: readonly Row[] },
    number
  >({
    source: () => ({ text: this.text(), rows: this.rows() }),
    computation: ({ text, rows }, previous) => {
      const highlighted =
        previous?.source.text === text ? previous.source.rows[previous.value] : undefined;
      return highlighted ? rows.findIndex((row) => row.key === highlighted.key) : -1;
    },
  });
  /**
   * Why the text in the field cannot be added, once it was asked to be. Goes as soon as the text
   * changes: it is said of the text as it was.
   */
  protected readonly problem = linkedSignal<string, string | null>({
    source: this.text,
    computation: () => null,
  });
  protected readonly expanded = computed(() => this.focused() && this.rows().length > 0);
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
    const count = this.rows().length;
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
      case ',':
        // ⌘/Ctrl-comma is a shortcut, to the settings: nothing typed is added on the way.
        if (event.metaKey || event.ctrlKey) {
          break;
        }
        event.preventDefault();
        this.take();
        break;
      case 'Enter':
        event.preventDefault();
        this.take();
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

  /** Enter or comma: the highlighted line, or else what is typed. */
  private take(): void {
    const row = this.rows()[this.active()];
    if (row) {
      this.choose(row);
      return;
    }
    const typed = this.text();
    // Nothing typed is no name to refuse: the field loses its spaces, without a word.
    if (typed.trim() === '') {
      this.text.set('');
      return;
    }
    const tag = this.tags.resolve(typed);
    if (tag) {
      this.takeTag(tag);
    } else if (this.allowNew()) {
      this.commit(typed);
    } else {
      const check = normalizeTagName(typed);
      this.problem.set(
        check.ok
          ? `No tag is named “${quote(tagNameText(typed))}”.`
          : describeTagNameProblem(check.problem),
      );
    }
  }

  protected choose(row: Row): void {
    switch (row.action) {
      case 'create':
        this.commit(this.text());
        break;
      case 'edit':
        if (row.tag) {
          this.edit.emit(row.tag.id);
          this.text.set('');
        }
        break;
      case 'add':
      case 'refuse':
        if (row.tag) {
          this.takeTag(row.tag);
        }
        break;
    }
  }

  /** Adds an existing tag, by its name; says why when it cannot be chosen here. */
  private takeTag(tag: Tag): void {
    const reason = this.disabled().get(tag.id);
    if (reason === undefined) {
      this.add.emit(tag.name);
      this.text.set('');
    } else {
      this.problem.set(`${tag.name} ${reason}.`);
    }
  }

  /** Adds `typed` when it can be the name of a tag, and empties the field; says why otherwise. */
  private commit(typed: string): void {
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
