import { Component, computed, input } from '@angular/core';

export type IconName =
  | 'image'
  | 'film'
  | 'search'
  | 'x'
  | 'settings'
  | 'folder-plus'
  | 'trash'
  | 'external-link'
  | 'folder-open'
  | 'tag'
  | 'arrow-left'
  | 'alert'
  | 'hard-drive'
  | 'plus'
  | 'loader'
  | 'sort-desc'
  | 'sort-asc'
  | 'panel'
  | 'play'
  | 'copy';

/** A symbol from the sprite rendered once by `IconSprite`; sized by `font-size`, coloured by `color`. */
@Component({
  selector: 'app-icon',
  template: `<svg aria-hidden="true" focusable="false"><use [attr.href]="href()" /></svg>`,
  styleUrl: './icon.css',
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly href = computed(() => `#icon-${this.name()}`);
}
