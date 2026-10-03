import { provideHttpClient } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideMaterialSymbols } from '@ojiepermana/angular/component/icon';
import { provideApiConfiguration } from '@sdk';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideMaterialSymbols(),
    provideHttpClient(),
    provideApiConfiguration(''),
  ],
};
