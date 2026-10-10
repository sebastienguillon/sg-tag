import type { ApplicationConfig } from '@angular/core';
import {
  DOCUMENT,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { DESKTOP } from './core/desktop';
import { PreferencesStore } from './core/preferences-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAppInitializer(() => {
      // Lets styles adapt to the platform, e.g. room for the macOS traffic lights.
      inject(DOCUMENT).documentElement.dataset['platform'] = inject(DESKTOP).platform;
      return inject(PreferencesStore).load();
    }),
  ],
};
