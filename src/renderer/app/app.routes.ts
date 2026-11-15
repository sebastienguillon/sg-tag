import type { Routes } from '@angular/router';
import { BrowserPage } from './browser/browser-page';

export const routes: Routes = [
  { path: '', component: BrowserPage, title: 'SG Tag' },
  {
    path: 'tags',
    loadComponent: () => import('./tags/tags-page').then((m) => m.TagsPage),
    title: 'Tags — SG Tag',
  },
  {
    path: 'settings',
    loadComponent: () => import('./settings/settings-page').then((m) => m.SettingsPage),
    title: 'Settings — SG Tag',
  },
  { path: '**', redirectTo: '' },
];
