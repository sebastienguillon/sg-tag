import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IconSprite } from './ui/icon/icon-sprite';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, IconSprite],
  template: `<app-icon-sprite /><router-outlet />`,
  styleUrl: './app.css',
})
export class App {}
