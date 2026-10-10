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
import { TagsStore } from '../../core/tags-store';
import { Icon } from '../../ui/icon/icon';

let nextId = 0;

/**
 * Tag entry with autocompletion (ARIA combobox). Enter or comma adds; Tab completes the highlighted
 * suggestion so that `/` can continue into a sub-tag.
 */
@Component({
  selector: 'app-tag-input',
  imports: [Icon],
  templateUrl: './tag-input.html',
  styleUrl: './tag-input.css',
})
export class TagInput {
  private readonly tags = inject(TagsStore);

  /** Tag paths already applied, left out of suggestions. */
  readonly exclude = input<ReadonlySet<string>>(new Set());
  readonly add = output<string>();

  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  protected readonly listId = `tag-suggestions-${nextId++}`;
  protected readonly text = signal('');
  protected readonly focused = signal(false);
  protected readonly suggestions = computed(() => this.tags.suggest(this.text(), this.exclude()));
  protected readonly active = linkedSignal({ source: this.suggestions, computation: () => -1 });
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
      case 'Tab': {
        const suggestion = this.suggestions()[Math.max(0, this.active())];
        if (suggestion && this.text().trim() !== '' && this.text() !== suggestion.path) {
          this.text.set(suggestion.path);
          event.preventDefault();
        }
        break;
      }
      case 'Enter':
      case ',':
        event.preventDefault();
        this.commit(this.suggestions()[this.active()]?.path ?? this.text());
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

  protected commit(path: string): void {
    const value = path.trim();
    if (value !== '') {
      this.add.emit(value);
    }
    this.text.set('');
  }
}
