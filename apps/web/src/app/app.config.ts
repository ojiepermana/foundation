import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideUiTheme } from '@ojiepermana/angular/theme/styles';
import { routes } from './app.routes';
import { registerLocaleData } from '@angular/common';
import localeId from '@angular/common/locales/id';
registerLocaleData(localeId);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(), provideRouter(routes), provideHttpClient(), { provide: LOCALE_ID, useValue: 'id' },
    provideUiTheme({ mode: 'light', color: 'teal', neutral: 'zinc', radius: 'md', space: 'normal' }),
  ],
};
