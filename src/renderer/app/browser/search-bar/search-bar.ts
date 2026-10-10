import type { ElementRef } from '@angular/core';
import { Component, inject, output, viewChild } from '@angular/core';
import { LibraryStore } from '../../core/library-store';
import { Icon } from '../../ui/icon/icon';

/** Filters the grid on every keystroke; the syntax help lives in a native popover. */
@Component({
  selector: 'app-search-bar',
  imports: [Icon],
  templateUrl: './search-bar.html',
  styleUrl: './search-bar.css',
})
export class SearchBar {
  private readonly store = inject(LibraryStore);

  /** ↓ or Enter: continue in the results. */
  readonly leave = output();

  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');
  protected readonly query = this.store.query;

  focus(): void {
    const input = this.input().nativeElement;
    input.focus();
    input.select();
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected clear(): void {
    this.query.set('');
    this.input().nativeElement.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.query() !== '') {
      event.preventDefault();
      this.clear();
    } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      this.leave.emit();
    }
  }
}
