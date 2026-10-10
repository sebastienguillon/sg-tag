import { bootstrapApplication } from '@angular/platform-browser';
import { createLogger } from '@shared/log';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig).catch((error: unknown) => {
  createLogger('bootstrap').error(error);
});
