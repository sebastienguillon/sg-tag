import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { DESKTOP } from './core/desktop';
import { IconSprite } from './ui/icon/icon-sprite';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, IconSprite],
  template: `<app-icon-sprite /><router-outlet />`,
  styleUrl: './app.css',
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class App {
  private readonly router = inject(Router);
  private readonly isMac = inject(DESKTOP).platform === 'darwin';

  /**
   * The shortcuts that work from every page: ⌘/Ctrl-Shift-T for the tags page, ⌘/Ctrl-comma for
   * Settings. Matched on the character typed, not on the key that types it, so that they are where
   * the keyboard writes those characters (on a French AZERTY keyboard, the comma is a key of its
   * own, where M is on QWERTY). With Shift, macOS may give ⌘-T as a small letter: case aside.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const modifier = this.isMac ? event.metaKey : event.ctrlKey;
    if (!modifier) {
      return;
    }
    if (event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      void this.router.navigate(['/tags']);
    } else if (event.key === ',') {
      event.preventDefault();
      void this.router.navigate(['/settings']);
    }
  }
}
